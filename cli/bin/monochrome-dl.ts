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
import { checkFfmpeg, isCustomFormat } from '../src/transcode.js';
import { cacheClear, cacheStats } from '../src/cache.js';
import { downloadTrack, downloadAlbum, detectIdType } from '../src/downloader.js';
import type { DownloadOpts } from '../src/downloader.js';

const program = new Command();

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
    .option('--container <format>', 'Lossless container: nochange, flac, alac', 'nochange')

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

    // Validate quality
    const validQualities = [
        'HI_RES_LOSSLESS',
        'LOSSLESS',
        'HIGH',
        'LOW',
        'FFMPEG_MP3_320',
        'FFMPEG_MP3_256',
        'FFMPEG_MP3_128',
        'FFMPEG_OGG_320',
        'FFMPEG_OGG_256',
        'FFMPEG_OGG_128',
        'FFMPEG_AAC_256',
    ];
    const quality = opts.quality.toUpperCase();
    if (!validQualities.includes(quality)) {
        throw new Error(`Invalid quality: ${opts.quality}\nValid options: ${validQualities.join(', ')}`);
    }

    // Validate container
    const container = opts.container.toLowerCase();
    if (!['nochange', 'flac', 'alac'].includes(container)) {
        throw new Error(`Invalid container: ${opts.container}\nValid options: nochange, flac, alac`);
    }

    // Check ffmpeg if custom format or container conversion requested
    if (isCustomFormat(quality) || container !== 'nochange') {
        const hasFfmpeg = await checkFfmpeg();
        if (!hasFfmpeg) {
            throw new Error('ffmpeg is required for transcoding/container conversion but was not found on PATH');
        }
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

    // Obtain token
    log.info('Authenticating...');
    await getToken();
    log.success('Authenticated');

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

program.parse();
