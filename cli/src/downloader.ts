import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { log } from './log.js';
import type { ApiClient, Track, Album, RgInfo, StreamResult } from './api.js';
import type { Instances } from './instances.js';
import { proxyPool } from './proxy.js';
import { applyPostProcessing, getExtensionForQuality, isCustomFormat, decryptCencMp4 } from './transcode.js';
import { addMetadata, buildTrackMetadata } from './metadata.js';
import { fetchLyrics, toLRC, convertLRCToRomaji } from './lyrics.js';
import { generateM3U, generateM3U8, generateCUE, generateNFO, generateJSON } from './sidecars.js';
import { assertNotBlocked } from './content-filter.js';
// @ts-expect-error - JS module without full types
import { sanitizeForFilename, formatTemplate, formatPathTemplate, getTrackTitle } from '#js/utils.js';
export interface DownloadOpts {
    quality?: string;
    preferAtmos?: boolean;
    container?: string;
    filenameTemplate?: string;
    folderTemplate?: string;
    writeArtistsSeparately?: boolean;
    downloadLyrics?: boolean;
    romajiLyrics?: boolean;
    coverSize?: string;
    generateM3u?: boolean;
    generateM3u8?: boolean;
    generateCue?: boolean;
    generateNfo?: boolean;
    generateJson?: boolean;
    relativePaths?: boolean;
    separateDiscs?: boolean;
    includeCover?: boolean;
    concurrency?: number;
}

function buildTrackFilename(track: Track, quality: string, filenameTemplate: string, extension: string | null = null): string {
    const ext = extension || getExtensionForQuality(quality);
    const artistName = track.artist?.name || track.artists?.[0]?.name || 'Unknown Artist';

    const data = {
        discNumber: track.volumeNumber || 1,
        trackNumber: track.trackNumber,
        artist: artistName,
        title: getTrackTitle(track),
        album: track.album?.title,
    };

    return formatTemplate(filenameTemplate, data) + '.' + ext;
}

function buildAlbumFolder(album: Album, folderTemplate: string): string {
    const artistName = album.artist?.name || album.artists?.[0]?.name || 'Unknown Artist';
    const year = album.releaseDate ? new Date(album.releaseDate).getFullYear() : 'Unknown';

    return formatPathTemplate(folderTemplate, {
        albumTitle: album.title,
        albumArtist: artistName,
        year,
    });
}

/**
 * Probe a DASH manifest to find the best audio stream index.
 */
async function probeBestAudioStream(url: string): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
        execFile(
            'ffprobe',
            ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'a', url],
            { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
            (err, stdout) => {
                if (err || !stdout) {
                    resolve(null);
                    return;
                }
                try {
                    const data = JSON.parse(stdout) as { streams?: any[] };
                    const streams = data.streams || [];
                    if (streams.length === 0) {
                        resolve(null);
                        return;
                    }

                    const codecPriority: Record<string, number> = { flac: 0, alac: 1, aac: 2, mp4a: 2 };
                    let best: number | null = null;
                    let bestScore = Infinity;
                    let bestBitrate = 0;

                    for (const s of streams) {
                        const codec = (s.codec_name || '').toLowerCase();
                        const profile = (s.profile || '').toLowerCase();
                        let score = codecPriority[codec] ?? 10;
                        if (codec === 'aac' && profile.includes('he')) score = 3;
                        const bitrate = parseInt(s.bit_rate || s.tags?.variant_bitrate || '0', 10);

                        if (score < bestScore || (score === bestScore && bitrate > bestBitrate)) {
                            best = s.index;
                            bestScore = score;
                            bestBitrate = bitrate;
                        }
                    }
                    resolve(best);
                } catch {
                    resolve(null);
                }
            }
        );
    });
}

/**
 * Download a DASH stream via ffmpeg (handles .mpd manifests).
 */
async function downloadDashViaFfmpeg(
    url: string,
    _outputExt = 'flac',
    durationSec: number | null = null,
    decryption?: { key: string; keyId?: string }
): Promise<Buffer> {
    const id = randomBytes(8).toString('hex');
    const outPath = join(tmpdir(), `mono-dash-${id}.mka`);

    try {
        const bestIdx = await probeBestAudioStream(url);
        const mapArg = bestIdx != null ? `0:${bestIdx}` : '0:a';
        log.verbose(`  Selected stream index: ${bestIdx ?? 'all audio'}`);

        const args = ['-y'];
        if (decryption) {
            args.push('-decryption_key', decryption.key);
        }
        args.push('-i', url, '-map', mapArg, '-c', 'copy', '-map_metadata', '-1', outPath);

        await new Promise<void>((resolve, reject) => {
            const proc = execFile('ffmpeg', args,
                { maxBuffer: 100 * 1024 * 1024, timeout: 300000 },
                (err, _stdout, stderr) => {
                    if (err) {
                        log.verbose(`  ffmpeg DASH stderr: ${stderr?.slice(-500)}`);
                        reject(new Error(`ffmpeg DASH download failed: ${err.message}`));
                    } else {
                        resolve();
                    }
                }
            );

            if (proc.stderr) {
                let lastTime = '';
                proc.stderr.on('data', (chunk: Buffer) => {
                    const text = chunk.toString();
                    const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
                    if (timeMatch && timeMatch[1] !== lastTime) {
                        lastTime = timeMatch[1];
                        log.dashProgress(lastTime, durationSec);
                    }
                });
            }
        });
        log.progressEnd();

        return await readFile(outPath);
    } finally {
        await unlink(outPath).catch(() => {});
    }
}

/**
 * Download audio via direct HTTP streaming.
 */
async function downloadHttpStream(url: string): Promise<Buffer> {
    // Bypass the cuimp-overridden globalThis.fetch: direct CDN URLs don't need
    // TLS impersonation and cuimp buffers the whole body before returning,
    // which hides progress and can stall on HEAD requests through SOCKS5.
    const nodeFetch = proxyPool.originalFetch;

    const response = await nodeFetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Stream fetch failed: ${response.status}`);

    let totalBytes: number | null = null;
    const cl = response.headers.get('Content-Length');
    if (cl) totalBytes = parseInt(cl, 10);

    const chunks: Uint8Array[] = [];
    let received = 0;

    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            if (totalBytes) {
                log.progress(received, totalBytes, `${(received / 1024 / 1024).toFixed(1)} MB`);
            }
        }
        if (totalBytes) log.progressEnd();
    } else {
        const arrayBuffer = await response.arrayBuffer();
        chunks.push(new Uint8Array(arrayBuffer));
    }

    return Buffer.concat(chunks);
}

/**
 * Download a single track's audio data as a Buffer.
 */
async function downloadAudioBuffer(
    apiClient: ApiClient,
    _instances: Instances,
    trackId: string | number,
    quality: string,
    preferAtmos: boolean,
    track: Track
): Promise<{ buffer: Buffer; postProcessingQuality: string; rgInfo: RgInfo | null }> {
    const downloadQuality = isCustomFormat(quality) ? 'LOSSLESS' : quality;

    let stream: StreamResult | null = null;
    let postProcessingQuality: string = downloadQuality;

    if (preferAtmos && track?.audioModes?.includes('DOLBY_ATMOS')) {
        try {
            stream = await apiClient.getStreamUrl(trackId, 'DOLBY_ATMOS', true);
            postProcessingQuality = 'DOLBY_ATMOS';
            log.verbose('  Using Dolby Atmos stream');
        } catch (err) {
            log.verbose(`  Dolby Atmos failed, falling back: ${(err as Error).message}`);
        }
    }

    if (!stream) {
        stream = await apiClient.getStreamUrl(trackId, downloadQuality, true);
        postProcessingQuality = downloadQuality;
    }

    if (!stream?.url) {
        throw new Error(`Could not resolve stream URL for track ${trackId}`);
    }

    log.verbose(
        `  Stream: ${stream.provider ?? 'unknown'}/${stream.playbackType ?? 'direct'} ${stream.url.substring(0, 80)}...`
    );

    const buffer = await downloadStream(stream, postProcessingQuality, track?.duration || null);

    return { buffer, postProcessingQuality, rgInfo: stream.rgInfo };
}

async function downloadStream(
    stream: StreamResult,
    postProcessingQuality: string,
    durationSec: number | null
): Promise<Buffer> {
    const { url, playbackType, decryptionKey, keyId, mimeType, codec } = stream;
    const isManifest =
        playbackType === 'dash' ||
        playbackType === 'dash-cenc' ||
        playbackType === 'hls' ||
        url.endsWith('.mpd') ||
        url.includes('.mpd?') ||
        url.includes('.m3u8') ||
        (mimeType && (mimeType.includes('dash') || mimeType.includes('mpegurl')));

    if (isManifest) {
        const ext = getExtensionForQuality(postProcessingQuality);
        return downloadDashViaFfmpeg(url, ext, durationSec, decryptionKey ? { keyId, key: decryptionKey } : undefined);
    }

    if (decryptionKey) {
        const raw = await downloadHttpStream(url);
        const ext = codec === 'flac' || mimeType?.includes('flac') ? 'flac' : 'm4a';
        return decryptCencMp4(raw, decryptionKey, { keyId, outputFormat: ext });
    }

    return downloadHttpStream(url);
}

/**
 * Download a single track to disk.
 */
export async function downloadTrack(
    apiClient: ApiClient,
    instances: Instances,
    track: Track,
    outputDir: string,
    opts: DownloadOpts
): Promise<{ filename: string; extension: string; coverBuffer: Buffer | null }> {
    const {
        quality = 'HI_RES_LOSSLESS',
        preferAtmos = false,
        container = 'nochange',
        filenameTemplate = '{trackNumber} - {artist} - {title}',
        writeArtistsSeparately = false,
        downloadLyrics = false,
        romajiLyrics = false,
        coverSize = '1280',
        includeCover = true,
    } = opts;

    assertNotBlocked(track, 'track');

    const trackTitle = getTrackTitle(track);
    const artistName = track.artist?.name || track.artists?.[0]?.name || 'Unknown Artist';
    log.info(`  ${artistName} - ${trackTitle}`);

    const { buffer: rawBuffer, postProcessingQuality, rgInfo } = await downloadAudioBuffer(
        apiClient,
        instances,
        track.id,
        quality,
        preferAtmos,
        track
    );

    const { buffer: processedBuffer, extension } = await applyPostProcessing(
        rawBuffer,
        quality,
        container,
        postProcessingQuality
    );

    let coverBuffer: Buffer | null = null;
    let coverId: string | undefined = track.album?.cover;
    if (!coverId && track.album?.id) {
        try {
            const { album: albumData } = await apiClient.getAlbum(track.album.id);
            if (albumData?.cover) coverId = albumData.cover;
        } catch {
            log.verbose('  Could not fetch album for cover art');
        }
    }
    if (coverId) {
        try {
            const coverUrl = apiClient.getCoverUrl(coverId, coverSize);
            if (coverUrl) {
                log.verbose(`  Fetching cover: ${coverUrl}`);
                const coverRes = await fetch(coverUrl);
                if (coverRes.ok) coverBuffer = Buffer.from(await coverRes.arrayBuffer());
            }
        } catch (err) {
            log.verbose(`  Cover art fetch failed: ${(err as Error).message}`);
        }
    }

    const metadata = buildTrackMetadata(track, track.album ?? null, rgInfo);
    const taggedBuffer = await addMetadata(processedBuffer, extension, metadata, coverBuffer, {
        writeArtistsSeparately,
    });

    const filename = buildTrackFilename(track, quality, filenameTemplate, extension);
    const outputPath = join(outputDir, filename);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, taggedBuffer);
    log.success(`  Saved: ${filename}`);

    if (downloadLyrics) {
        try {
            const lyrics = await fetchLyrics(apiClient, instances, track.id);
            if (lyrics.synced || lyrics.plain) {
                let lrcContent = toLRC(lyrics.synced || lyrics.plain, {
                    title: trackTitle,
                    artist: artistName,
                    album: track.album?.title,
                });
                if (romajiLyrics && lrcContent) {
                    lrcContent = await convertLRCToRomaji(lrcContent);
                }
                if (lrcContent) {
                    const lrcFilename = filename.replace(/\.[^.]+$/, '.lrc');
                    await writeFile(join(outputDir, lrcFilename), lrcContent, 'utf-8');
                    log.verbose(`  Saved lyrics: ${lrcFilename}`);
                }
            }
        } catch (err) {
            log.verbose(`  Lyrics failed: ${(err as Error).message}`);
        }
    }

    if (includeCover && coverBuffer) {
        return { filename, extension, coverBuffer };
    }

    return { filename, extension, coverBuffer: null };
}

/**
 * Download an entire album to disk.
 */
export async function downloadAlbum(
    apiClient: ApiClient,
    instances: Instances,
    albumId: string | number,
    outputDir: string,
    opts: DownloadOpts
): Promise<{ albumDir: string; trackCount: number }> {
    const {
        quality = 'HI_RES_LOSSLESS',
        preferAtmos = false,
        container = 'nochange',
        filenameTemplate = '{trackNumber} - {artist} - {title}',
        folderTemplate = '{albumArtist} - {albumTitle}',
        writeArtistsSeparately = false,
        downloadLyrics = false,
        romajiLyrics = false,
        coverSize = '1280',
        generateM3u = true,
        generateM3u8 = false,
        generateCue = false,
        generateNfo = false,
        generateJson = false,
        relativePaths = true,
        separateDiscs = false,
        includeCover = true,
        concurrency = 3,
    } = opts;

    log.info(`Fetching album ${albumId}...`);
    const { album, tracks } = await apiClient.getAlbum(albumId);
    assertNotBlocked(album, 'album');
    const albumArtist = album.artist?.name || album.artists?.[0]?.name || 'Unknown Artist';
    log.info(`Album: ${albumArtist} - ${album.title} (${tracks.length} tracks)`);

    const albumFolder = buildAlbumFolder(album, folderTemplate);
    const albumDir = join(outputDir, albumFolder);
    await mkdir(albumDir, { recursive: true });

    const hasMultipleDiscs = album.numberOfVolumes > 1 || tracks.some((t) => (t.volumeNumber || 1) > 1);

    const trackPaths: (string | null)[] = [];
    let albumCover: Buffer | null = null;

    for (let i = 0; i < tracks.length; i += concurrency) {
        const batch = tracks.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (track, batchIdx) => {
                const trackIdx = i + batchIdx;
                let trackDir = albumDir;
                let pathPrefix = '';

                if (separateDiscs && hasMultipleDiscs) {
                    const discNum = track.volumeNumber || 1;
                    const discFolder = `Disc ${discNum}`;
                    trackDir = join(albumDir, discFolder);
                    pathPrefix = discFolder + '/';
                    await mkdir(trackDir, { recursive: true });
                }

                try {
                    const result = await downloadTrack(apiClient, instances, track, trackDir, {
                        quality,
                        preferAtmos,
                        container,
                        filenameTemplate,
                        writeArtistsSeparately,
                        downloadLyrics,
                        romajiLyrics,
                        coverSize,
                        includeCover: false,
                    });

                    const trackPath = relativePaths
                        ? pathPrefix + result.filename
                        : join(trackDir, result.filename);

                    if (!albumCover && result.coverBuffer) {
                        albumCover = result.coverBuffer;
                    }

                    return { trackIdx, path: trackPath, success: true };
                } catch (err) {
                    log.error(`  Failed to download track ${track.id}: ${(err as Error).message}`);
                    return { trackIdx, path: null, success: false };
                }
            })
        );

        for (const r of results) {
            trackPaths[r.trackIdx] = r.path;
        }
    }

    if (!albumCover && album.cover) {
        try {
            const coverUrl = apiClient.getCoverUrl(album.cover, coverSize);
            if (coverUrl) {
                const coverRes = await fetch(coverUrl);
                if (coverRes.ok) albumCover = Buffer.from(await coverRes.arrayBuffer());
            }
        } catch {
            /* ignore */
        }
    }

    if (includeCover && albumCover) {
        await writeFile(join(albumDir, 'cover.jpg'), albumCover);
        log.verbose('  Saved: cover.jpg');
    }

    const playlistMeta = {
        title: album.title,
        artist: album.artist,
        id: album.id,
        releaseDate: album.releaseDate,
    };

    if (generateM3u) {
        const content = generateM3U(playlistMeta, tracks, true, null, 'flac', trackPaths);
        await writeFile(join(albumDir, `${sanitizeForFilename(album.title)}.m3u`), content, 'utf-8');
        log.verbose('  Generated M3U');
    }

    if (generateM3u8) {
        const content = generateM3U8(playlistMeta, tracks, true, null, 'flac', trackPaths);
        await writeFile(join(albumDir, `${sanitizeForFilename(album.title)}.m3u8`), content, 'utf-8');
        log.verbose('  Generated M3U8');
    }

    if (generateCue) {
        const content = generateCUE(album, tracks, null, trackPaths);
        await writeFile(join(albumDir, `${sanitizeForFilename(album.title)}.cue`), content, 'utf-8');
        log.verbose('  Generated CUE');
    }

    if (generateNfo) {
        const content = generateNFO(playlistMeta, tracks, 'album');
        await writeFile(join(albumDir, `${sanitizeForFilename(album.title)}.nfo`), content, 'utf-8');
        log.verbose('  Generated NFO');
    }

    if (generateJson) {
        const content = generateJSON(playlistMeta, tracks, 'album');
        await writeFile(join(albumDir, `${sanitizeForFilename(album.title)}.json`), content, 'utf-8');
        log.verbose('  Generated JSON');
    }

    log.success(`Album complete: ${albumFolder}`);
    return { albumDir, trackCount: tracks.length };
}

/**
 * Auto-detect whether an ID is a track or album by querying the API.
 */
export async function detectIdType(apiClient: ApiClient, id: string | number): Promise<'track' | 'album'> {
    try {
        const { album } = await apiClient.getAlbum(id);
        if (album && album.title) return 'album';
    } catch {
        /* not an album */
    }

    try {
        const { track } = await apiClient.getTrack(id);
        if (track && track.title) return 'track';
    } catch {
        /* not a track */
    }

    throw new Error(`Could not identify ID ${id} as a track or album`);
}
