import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { log } from './log.js';
// @ts-expect-error - JS module without full types
import { getTrackTitle } from '#js/utils.js';
import type { Track, AlbumSummary, RgInfo } from './api.js';

export interface TrackMetadata {
    title: string;
    artist: string;
    artists: Array<string | { name?: string }>;
    albumTitle: string | null;
    albumArtist: string;
    trackNumber: number | null;
    totalTracks: number | null;
    discNumber: number;
    totalDiscs: number | null;
    releaseDate: string | null;
    year: number | null;
    copyright: string | null;
    isrc: string | null;
    upc: string | null;
    tidalTrackId: string;
    tidalAlbumId: string | null;
    replayGain: RgInfo | null;
}

/**
 * Add metadata to an audio file buffer using ffmpeg.
 */
export async function addMetadata(
    audioBuffer: Buffer,
    extension: string,
    metadata: TrackMetadata,
    coverBuffer: Buffer | null = null,
    opts: { writeArtistsSeparately?: boolean } = {}
): Promise<Buffer> {
    const { writeArtistsSeparately = false } = opts;
    const id = randomBytes(8).toString('hex');
    const inPath = join(tmpdir(), `mono-in-${id}.${extension}`);
    const outPath = join(tmpdir(), `mono-out-${id}.${extension}`);
    const coverPath = coverBuffer ? join(tmpdir(), `mono-cover-${id}.jpg`) : null;

    try {
        await writeFile(inPath, audioBuffer);
        if (coverBuffer && coverPath) {
            await writeFile(coverPath, coverBuffer);
        }

        const args = ['-y', '-i', inPath];

        if (coverPath) {
            args.push('-i', coverPath);
        }

        const metaArgs = buildMetadataArgs(metadata, extension, writeArtistsSeparately);
        args.push(...metaArgs);

        args.push('-map', '0:a');
        if (coverPath) {
            if (extension === 'mp3') {
                args.push(
                    '-map', '1:v', '-c:v', 'copy', '-id3v2_version', '3',
                    '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)'
                );
            } else if (extension === 'flac') {
                args.push(
                    '-map', '1:v', '-c:v', 'copy',
                    '-disposition:v:0', 'attached_pic',
                    '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)'
                );
            } else if (extension === 'm4a') {
                args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
            }
        }

        args.push('-c:a', 'copy');
        args.push(outPath);

        log.verbose(`  ffmpeg metadata: ${args.join(' ')}`);

        await new Promise<void>((resolve, reject) => {
            execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
                if (err) {
                    log.verbose(`  ffmpeg metadata stderr: ${stderr}`);
                    reject(new Error(`ffmpeg metadata failed: ${err.message}`));
                } else {
                    resolve();
                }
            });
        });

        return await readFile(outPath);
    } catch (err) {
        log.warn(`Metadata tagging failed: ${(err as Error).message}`);
        return audioBuffer;
    } finally {
        await unlink(inPath).catch(() => {});
        await unlink(outPath).catch(() => {});
        if (coverPath) await unlink(coverPath).catch(() => {});
    }
}

function buildMetadataArgs(metadata: TrackMetadata, extension: string, writeArtistsSeparately: boolean): string[] {
    const args: string[] = [];

    function meta(key: string, value: string | number | null | undefined): void {
        if (value != null && value !== '') {
            args.push('-metadata', `${key}=${value}`);
        }
    }

    meta('title', metadata.title);

    if (metadata.artists && metadata.artists.length > 0) {
        const artistNames = metadata.artists
            .map((a) => (typeof a === 'string' ? a : a.name))
            .filter(Boolean) as string[];

        if (writeArtistsSeparately && (extension === 'flac' || extension === 'ogg')) {
            for (const name of artistNames) {
                args.push('-metadata', `ARTIST=${name}`);
            }
        } else if (writeArtistsSeparately && extension === 'm4a') {
            meta('artist', artistNames.join('; '));
        } else {
            meta('artist', artistNames.join(', '));
        }
    } else if (metadata.artist) {
        meta('artist', metadata.artist);
    }

    meta('album', metadata.albumTitle);

    if (metadata.albumArtist) {
        meta('album_artist', metadata.albumArtist);
    }

    if (metadata.trackNumber) {
        if (metadata.totalTracks) {
            meta('track', `${metadata.trackNumber}/${metadata.totalTracks}`);
        } else {
            meta('track', String(metadata.trackNumber));
        }
    }

    if (metadata.discNumber) {
        if (metadata.totalDiscs) {
            meta('disc', `${metadata.discNumber}/${metadata.totalDiscs}`);
        } else {
            meta('disc', String(metadata.discNumber));
        }
    }

    if (metadata.year) {
        meta('date', String(metadata.year));
    } else if (metadata.releaseDate) {
        meta('date', metadata.releaseDate);
    }

    meta('copyright', metadata.copyright);
    meta('isrc', metadata.isrc);

    if (metadata.replayGain) {
        const rg = metadata.replayGain;
        meta('REPLAYGAIN_TRACK_GAIN', rg.trackReplayGain != null ? `${rg.trackReplayGain} dB` : undefined);
        meta('REPLAYGAIN_TRACK_PEAK', rg.trackPeakAmplitude != null ? String(rg.trackPeakAmplitude) : undefined);
        meta('REPLAYGAIN_ALBUM_GAIN', rg.albumReplayGain != null ? `${rg.albumReplayGain} dB` : undefined);
        meta('REPLAYGAIN_ALBUM_PEAK', rg.albumPeakAmplitude != null ? String(rg.albumPeakAmplitude) : undefined);
    }

    meta('TIDAL_TRACK_ID', metadata.tidalTrackId);
    meta('TIDAL_ALBUM_ID', metadata.tidalAlbumId);
    meta('UPC', metadata.upc);

    return args;
}

/**
 * Build metadata object from track and album data.
 */
export function buildTrackMetadata(track: Track, album: AlbumSummary | null = null, rgInfo: RgInfo | null = null): TrackMetadata {
    const albumData = (track.album || album || {}) as AlbumSummary;
    const artistName = track.artist?.name || track.artists?.[0]?.name || 'Unknown Artist';
    const albumArtistName = albumData.artist?.name || albumData.artists?.[0]?.name || artistName;

    return {
        title: getTrackTitle(track),
        artist: artistName,
        artists: track.artists || [],
        albumTitle: albumData.title || null,
        albumArtist: albumArtistName,
        trackNumber: track.trackNumber || null,
        totalTracks: albumData.numberOfTracks || null,
        discNumber: track.volumeNumber || 1,
        totalDiscs: albumData.numberOfVolumes || null,
        releaseDate: albumData.releaseDate || track.streamStartDate || null,
        year: albumData.releaseDate ? new Date(albumData.releaseDate).getFullYear() : null,
        copyright: track.copyright || albumData.copyright || null,
        isrc: track.isrc || null,
        upc: albumData.upc || null,
        tidalTrackId: String(track.id),
        tidalAlbumId: albumData.id ? String(albumData.id) : null,
        replayGain: rgInfo || null,
    };
}
