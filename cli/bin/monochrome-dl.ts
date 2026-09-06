#!/usr/bin/env node

// Stub browser globals before any `#js/*` imports run. The shared modules
// (e.g. `js/ModernSettings.ts`, `js/storage.js`) call `localStorage.getItem`
// while initializing their settings singletons; under Node that would throw
// and Vite prints the stack. A no-op stub keeps init quiet.
import './bootstrap-browser-globals.js';

import { Command } from 'commander';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { log } from '../src/log.js';
import { resolveInstances } from '../src/instances.js';
import { createApiClient, getToken } from '../src/api.js';
import { checkFfmpeg, isCustomFormat, CUSTOM_FORMAT_NAMES, CONTAINER_FORMAT_NAMES } from '../src/transcode.js';
import { cacheClear, cacheStats } from '../src/cache.js';
import { downloadTrack, downloadAlbum, detectIdType } from '../src/downloader.js';
import { proxyPool, fetchMullvadRelays } from '../src/proxy.js';
import type { DownloadOpts } from '../src/downloader.js';
import {
    buildTrackInfo,
    buildAlbumInfo,
    formatTrackText,
    formatAlbumText,
    type TrackInfoJson,
    type AlbumInfoJson,
} from '../src/info.js';
// @ts-expect-error - JS module without full types
import { AUDIO_QUALITIES, normalizeQualityToken } from '#js/utils.js';

const program = new Command();

// Tidal stream tiers plus every ffmpeg format the web app offers. Both lists
// come from the shared modules so upstream additions (e.g. Opus) work here too.
const STREAM_QUALITIES: string[] = Object.keys(AUDIO_QUALITIES as Record<string, string>);
const VALID_QUALITIES: string[] = [...STREAM_QUALITIES, ...CUSTOM_FORMAT_NAMES];
const VALID_CONTAINERS: string[] = ['nochange', ...CONTAINER_FORMAT_NAMES];

function collect(val: string, acc: string[]): string[] {
    acc.push(val);
    return acc;
}

function parseIntArg(val: string): number {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 1) throw new Error('Must be a positive integer');
    return n;
}

program
    .name('monochrome-dl')
    .description('Download Tidal tracks and albums via Monochrome')
    .version('1.0.0')
    .argument('[ids...]', 'Tidal track or album IDs (auto-detected)')

    // Output
    .option('-o, --output-dir <path>', 'Output directory', '.')

    // Download Quality
    .option('-q, --quality <quality>', 'Audio quality or format', 'HI_RES_LOSSLESS')
    .option('--atmos', 'Prefer Dolby Atmos when available', false)
    .option('--container <format>', `Lossless container: ${VALID_CONTAINERS.join(', ')}`, 'nochange')

    // Metadata & Extras
    .option('--write-artists-separately', 'Write artists as separate metadata fields', false)
    .option('--lyrics', 'Download .lrc lyric files alongside tracks', false)
    .option('--romaji', 'Convert Japanese lyrics to Romaji', false)
    .option('--cover-size <size>', 'Cover art size (e.g. 1280)', '1280')
    .option('--no-cover-file', "Don't include cover.jpg in album downloads")

    // Templates
    .option('--filename-template <tpl>', 'Filename template', '{trackNumber} - {artist} - {title}')
    .option('--folder-template <tpl>', 'Folder template for albums', '{albumArtist} - {albumTitle}')

    // Sidecar generation
    .option('--m3u', 'Generate M3U playlist', true)
    .option('--no-m3u', "Don't generate M3U playlist")
    .option('--m3u8', 'Generate M3U8 playlist', false)
    .option('--cue', 'Generate CUE sheet', false)
    .option('--nfo', 'Generate NFO file', false)
    .option('--json', 'Generate JSON metadata file', false)
    .option('--no-relative-paths', 'Use absolute paths in playlists')
    .option('--separate-discs', 'Put tracks in Disc N/ subfolders', false)

    // Instances
    .option('--instance <url>', 'Custom API instance URL (repeatable)', collect, [] as string[])
    .option('--no-default-instances', 'Only use custom --instance URLs')

    // Proxy
    .option('--socks5-proxy <host>', 'SOCKS5 proxy host[:port] (default port 1080)')
    .option('--mullvad-relays', 'Auto-fetch Mullvad SOCKS5 relays and rotate on rate-limit', false)

    // System
    .option('--no-cache', 'Disable API response caching')
    .option('--clear-cache', 'Clear cache and exit')
    .option('--concurrency <n>', 'Parallel track downloads', parseIntArg, 3)
    .option('-v, --verbose', 'Verbose logging', false);

interface CliOpts {
    outputDir: string;
    quality: string;
    atmos: boolean;
    container: string;
    writeArtistsSeparately: boolean;
    lyrics: boolean;
    romaji: boolean;
    coverSize: string;
    coverFile: boolean;
    filenameTemplate: string;
    folderTemplate: string;
    m3u: boolean;
    m3u8: boolean;
    cue: boolean;
    nfo: boolean;
    json: boolean;
    relativePaths: boolean;
    separateDiscs: boolean;
    instance: string[];
    defaultInstances: boolean;
    socks5Proxy?: string;
    mullvadRelays: boolean;
    cache: boolean;
    clearCache?: boolean;
    concurrency: number;
    verbose: boolean;
}

program.action(async (ids: string[], opts: CliOpts) => {
    try {
        await run(ids, opts);
    } catch (err) {
        log.error((err as Error).message);
        if (opts.verbose) console.error((err as Error).stack);
        process.exit(1);
    }
});

async function run(ids: string[], opts: CliOpts): Promise<void> {
    log.setVerbose(opts.verbose);

    if (opts.clearCache) {
        await cacheClear();
        log.success('Cache cleared (~/.cache/monochrome/)');
        return;
    }

    if (!ids || ids.length === 0) {
        throw new Error('At least one track or album ID is required. Use --help for usage.');
    }

    // Validate quality. `normalizeQualityToken` accepts the same aliases the
    // web app does (e.g. `hifi_plus`, `flac`) before we check the canonical set.
    const requested = opts.quality.toUpperCase();
    const quality: string = VALID_QUALITIES.includes(requested)
        ? requested
        : (normalizeQualityToken(opts.quality) as string | null) || requested;
    if (!VALID_QUALITIES.includes(quality)) {
        throw new Error(`Invalid quality: ${opts.quality}\nValid options: ${VALID_QUALITIES.join(', ')}`);
    }

    // Validate container
    const container = opts.container.toLowerCase();
    if (!VALID_CONTAINERS.includes(container)) {
        throw new Error(`Invalid container: ${opts.container}\nValid options: ${VALID_CONTAINERS.join(', ')}`);
    }

    // Check ffmpeg if custom format or container conversion requested
    if (isCustomFormat(quality) || container !== 'nochange') {
        const hasFfmpeg = await checkFfmpeg();
        if (!hasFfmpeg) {
            throw new Error('ffmpeg is required for transcoding/container conversion but was not found on PATH');
        }
    }

    // Initialize SOCKS5 proxy pool (before any proxied requests)
    if (opts.mullvadRelays) {
        await fetchMullvadRelays();
    }
    if (opts.socks5Proxy) {
        const parts = opts.socks5Proxy.split(':');
        const host = parts.slice(0, -1).join(':') || parts[0];
        const port = parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : NaN;
        proxyPool.add(host, Number.isFinite(port) ? port : 1080);
    }
    if (proxyPool.size > 0) {
        await proxyPool.install();
    }

    // Resolve output dir
    const outputDir = resolve(opts.outputDir);
    await mkdir(outputDir, { recursive: true });

    // Resolve instances
    log.info('Resolving API instances...');
    const instances = await resolveInstances({
        customInstances: opts.instance,
        noDefaults: !opts.defaultInstances,
    });

    if (instances.api.length === 0) {
        throw new Error('No API instances available. Use --instance <url> to add one.');
    }

    log.verbose(`  API instances: ${instances.api.length}`);
    log.verbose(`  Streaming instances: ${instances.streaming.length}`);

    // Obtain token. Like `HiFiClient.init` upstream, a failure here is logged
    // rather than fatal: instance endpoints are unauthenticated, so only the
    // direct-Tidal fallbacks would be affected.
    log.info('Authenticating...');
    await authenticate();

    // Create API client
    const apiClient = createApiClient(instances, { useCache: opts.cache !== false });

    // Cache stats
    if (opts.verbose) {
        const stats = await cacheStats();
        log.verbose(`  Cache: ${stats.files} entries, ${(stats.bytes / 1024).toFixed(1)} KB`);
    }

    // Build shared options
    const downloadOpts: DownloadOpts = {
        quality,
        preferAtmos: opts.atmos,
        container,
        filenameTemplate: opts.filenameTemplate,
        folderTemplate: opts.folderTemplate,
        writeArtistsSeparately: opts.writeArtistsSeparately,
        downloadLyrics: opts.lyrics,
        romajiLyrics: opts.romaji,
        coverSize: opts.coverSize,
        generateM3u: opts.m3u,
        generateM3u8: opts.m3u8,
        generateCue: opts.cue,
        generateNfo: opts.nfo,
        generateJson: opts.json,
        relativePaths: opts.relativePaths !== false,
        separateDiscs: opts.separateDiscs,
        includeCover: opts.coverFile !== false,
        concurrency: opts.concurrency,
    };

    // Process each ID
    let totalTracks = 0;
    let totalAlbums = 0;
    let failures = 0;

    for (const id of ids) {
        try {
            log.info(`\nProcessing ID: ${id}`);
            const type = await detectIdType(apiClient, id);
            log.verbose(`  Detected type: ${type}`);

            if (type === 'album') {
                const result = await downloadAlbum(apiClient, instances, id, outputDir, downloadOpts);
                totalAlbums++;
                totalTracks += result.trackCount;
            } else {
                const { track } = await apiClient.getTrack(id, quality);
                await downloadTrack(apiClient, instances, track, outputDir, downloadOpts);
                totalTracks++;
            }
        } catch (err) {
            log.error(`Failed to process ${id}: ${(err as Error).message}`);
            if (opts.verbose) console.error((err as Error).stack);
            failures++;
        }
    }

    // Summary
    log.info('\n' + '─'.repeat(40));
    if (totalAlbums > 0) log.success(`Albums: ${totalAlbums}`);
    log.success(`Tracks: ${totalTracks}`);
    if (failures > 0) log.warn(`Failures: ${failures}`);
    log.info(`Output: ${outputDir}`);
}

/**
 * Fetch the Tidal app token, warning instead of aborting when it fails.
 */
async function authenticate(): Promise<void> {
    try {
        await getToken();
        log.success('Authenticated');
    } catch (err) {
        log.warn(`Failed to get app token, direct Tidal fallbacks won't work: ${(err as Error).message}`);
    }
}

interface InfoOpts {
    format: string;
    concurrency: number;
    instance: string[];
    defaultInstances: boolean;
    socks5Proxy?: string;
    mullvadRelays: boolean;
    cache: boolean;
    verbose: boolean;
}

program
    .command('info [ids...]')
    .description('Print metadata for tracks/albums without downloading')
    .option('-f, --format <fmt>', 'Output format: text or json', 'text')
    .option('--concurrency <n>', 'Parallel input fetches', parseIntArg, 3)
    .option('--instance <url>', 'Custom API instance URL (repeatable)', collect, [] as string[])
    .option('--no-default-instances', 'Only use custom --instance URLs')
    .option('--socks5-proxy <host>', 'SOCKS5 proxy host[:port] (default port 1080)')
    .option('--mullvad-relays', 'Auto-fetch Mullvad SOCKS5 relays and rotate on rate-limit', false)
    .option('--no-cache', 'Disable API response caching')
    .option('-v, --verbose', 'Verbose logging', false)
    .action(async (ids: string[], opts: InfoOpts) => {
        try {
            await runInfo(ids, opts);
        } catch (err) {
            log.error((err as Error).message);
            if (opts.verbose) console.error((err as Error).stack);
            process.exit(1);
        }
    });

interface InfoResult {
    input: string;
    type: 'track' | 'album';
    track?: TrackInfoJson;
    album?: AlbumInfoJson;
}

interface InfoError {
    input: string;
    error: string;
}

async function runInfo(ids: string[], opts: InfoOpts): Promise<void> {
    log.setVerbose(opts.verbose);

    const format = (opts.format || 'text').toLowerCase();
    if (format !== 'text' && format !== 'json') {
        throw new Error(`Invalid --format: ${opts.format}\nValid options: text, json`);
    }
    const jsonMode = format === 'json';

    if (!ids || ids.length === 0) {
        throw new Error('At least one track/album ID or URL is required. Use --help for usage.');
    }

    // Initialize SOCKS5 proxy pool
    if (opts.mullvadRelays) {
        await fetchMullvadRelays();
    }
    if (opts.socks5Proxy) {
        const parts = opts.socks5Proxy.split(':');
        const host = parts.slice(0, -1).join(':') || parts[0];
        const port = parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : NaN;
        proxyPool.add(host, Number.isFinite(port) ? port : 1080);
    }
    await proxyPool.install();

    log.info('Resolving API instances...');
    const instances = await resolveInstances({
        customInstances: opts.instance,
        noDefaults: !opts.defaultInstances,
    });

    if (instances.api.length === 0) {
        throw new Error('No API instances available. Use --instance <url> to add one.');
    }

    log.info('Authenticating...');
    await authenticate();

    const apiClient = createApiClient(instances, { useCache: opts.cache !== false });

    log.info('Resolving inputs...');
    const { resolved, errors: resolveErrors } = await resolveAllInputs(ids);

    const errors: InfoError[] = resolveErrors.map((e) => ({ input: e.input, error: e.error }));
    // Per-input slot, order-preserving so output matches input order regardless
    // of completion order. Each slot resolves to either a result or an error.
    type Slot = { result?: InfoResult; error?: InfoError };
    const slots: Slot[] = new Array(resolved.length);

    // Cookie isolation only matters between unrelated requests; with parallel
    // fetching that boundary doesn't exist, so clear once up front.
    proxyPool.clearCookies();

    const concurrency = Math.max(1, opts.concurrency || 1);
    let nextPrintIdx = 0;
    let first = true;

    const fetchOne = async (item: (typeof resolved)[number], idx: number): Promise<void> => {
        try {
            log.info(
                `Fetching: ${item.original}${item.original !== item.id ? ` (${item.type || 'auto'}:${item.id})` : ''}`
            );
            const type = item.type || (await detectIdType(apiClient, item.id));
            log.verbose(`  Detected type for ${item.original}: ${type}`);

            if (type === 'album') {
                const { album, tracks } = await apiClient.getAlbum(item.id);
                const info = buildAlbumInfo(album, tracks);
                slots[idx] = { result: { input: item.original, type: 'album', album: info } };
            } else {
                const { track } = await apiClient.getTrack(item.id);
                const info = buildTrackInfo(track);
                slots[idx] = { result: { input: item.original, type: 'track', track: info } };
            }
        } catch (err) {
            const msg = (err as Error).message;
            log.error(`Failed to fetch ${item.original}: ${msg}`);
            if (opts.verbose) console.error((err as Error).stack);
            slots[idx] = { error: { input: item.original, error: msg } };
        }
    };

    // Batched Promise.all over inputs — same pattern as the album track
    // downloader (see downloader.ts). After each batch, flush any contiguous
    // prefix of completed slots so text output streams in input order.
    for (let i = 0; i < resolved.length; i += concurrency) {
        const batch = resolved.slice(i, i + concurrency);
        await Promise.all(batch.map((item, bi) => fetchOne(item, i + bi)));

        if (!jsonMode) {
            while (nextPrintIdx < slots.length && slots[nextPrintIdx]) {
                const slot = slots[nextPrintIdx];
                if (slot.result) {
                    if (!first) console.log('');
                    if (slot.result.type === 'album' && slot.result.album) {
                        const a = slot.result.album;
                        console.log(formatAlbumText(a, { showTracks: a.tracks.length > 1 }));
                    } else if (slot.result.track) {
                        console.log(formatTrackText(slot.result.track));
                    }
                    first = false;
                }
                nextPrintIdx++;
            }
        }
    }

    const results: InfoResult[] = [];
    for (const slot of slots) {
        if (slot?.result) results.push(slot.result);
        else if (slot?.error) errors.push(slot.error);
    }

    if (jsonMode) {
        console.log(JSON.stringify({ results, errors }, null, 2));
    } else if (errors.length > 0) {
        log.warn(`\nErrors (${errors.length}):`);
        for (const e of errors) log.warn(`  ${e.input}: ${e.error}`);
    }

    if (results.length === 0 && errors.length > 0) {
        process.exit(1);
    }
}

program.parse();
