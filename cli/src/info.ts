import type { Track, Album } from './api.js';
// @ts-expect-error - JS module without full types
import { getTrackTitle } from '#js/utils.js';

export interface TrackInfoJson {
    id: string;
    title: string;
    version: string | null;
    displayTitle: string;
    artist: string | null;
    artists: string[];
    album: {
        id: string | null;
        title: string | null;
        artist: string | null;
    } | null;
    trackNumber: number | null;
    volumeNumber: number | null;
    duration: number | null;
    durationFormatted: string | null;
    audioQuality: string | null;
    audioModes: string[];
    mediaTags: string[];
    explicit: boolean;
    isrc: string | null;
    copyright: string | null;
    streamStartDate: string | null;
    url: string | null;
}

export interface AlbumInfoJson {
    id: string;
    title: string | null;
    artist: string | null;
    artists: string[];
    numberOfTracks: number;
    numberOfVolumes: number;
    duration: number | null;
    durationFormatted: string | null;
    releaseDate: string | null;
    audioQuality: string | null;
    audioModes: string[];
    copyright: string | null;
    upc: string | null;
    url: string | null;
    tracks: TrackInfoJson[];
}

export function formatDuration(seconds: number | null | undefined): string | null {
    if (seconds == null || !Number.isFinite(seconds)) return null;
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function artistNames(arr: { name?: string }[] | undefined): string[] {
    if (!arr || !arr.length) return [];
    return arr.map((a) => a?.name).filter((n): n is string => !!n);
}

function extractMediaTags(mm: unknown): string[] {
    if (!mm || typeof mm !== 'object') return [];
    const tags = (mm as { tags?: unknown }).tags;
    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is string => typeof t === 'string');
}

export function buildTrackInfo(track: Track): TrackInfoJson {
    const names = artistNames(track.artists);
    const primary = track.artist?.name || names[0] || null;
    const albumData = track.album || null;
    return {
        id: String(track.id),
        title: track.title,
        version: track.version || null,
        displayTitle: getTrackTitle(track),
        artist: primary,
        artists: names.length ? names : primary ? [primary] : [],
        album: albumData
            ? {
                  id: albumData.id != null ? String(albumData.id) : null,
                  title: albumData.title || null,
                  artist:
                      albumData.artist?.name ||
                      artistNames(albumData.artists)[0] ||
                      null,
              }
            : null,
        trackNumber: track.trackNumber ?? null,
        volumeNumber: track.volumeNumber ?? null,
        duration: track.duration ?? null,
        durationFormatted: formatDuration(track.duration),
        audioQuality: track.audioQuality || null,
        audioModes: track.audioModes || [],
        mediaTags: extractMediaTags(track.mediaMetadata),
        explicit: !!track.explicit,
        isrc: track.isrc || null,
        copyright: track.copyright || null,
        streamStartDate: track.streamStartDate || null,
        url: track.url || null,
    };
}

export function buildAlbumInfo(album: Album, tracks: Track[]): AlbumInfoJson {
    const names = artistNames(album.artists);
    const primary = album.artist?.name || names[0] || null;
    return {
        id: String(album.id),
        title: album.title || null,
        artist: primary,
        artists: names.length ? names : primary ? [primary] : [],
        numberOfTracks: album.numberOfTracks || tracks.length,
        numberOfVolumes: album.numberOfVolumes || 1,
        duration: album.duration ?? null,
        durationFormatted: formatDuration(album.duration),
        releaseDate: album.releaseDate || null,
        audioQuality: album.audioQuality || null,
        audioModes: album.audioModes || [],
        copyright: album.copyright || null,
        upc: album.upc || null,
        url: album.url || null,
        tracks: tracks.map(buildTrackInfo),
    };
}

function line(label: string, value: string | number | null | undefined): string | null {
    if (value == null || value === '') return null;
    return `  ${label.padEnd(14)} ${value}`;
}

function joinLines(parts: (string | null)[]): string {
    return parts.filter((p): p is string => p != null).join('\n');
}

export function formatTrackText(info: TrackInfoJson): string {
    const header = `Track ${info.id}: ${info.displayTitle}`;
    const artists =
        info.artists.length > 1 ? info.artists.join(', ') : info.artist || null;
    const albumStr = info.album
        ? info.album.artist
            ? `${info.album.title} — ${info.album.artist}${info.album.id ? ` [${info.album.id}]` : ''}`
            : `${info.album.title}${info.album.id ? ` [${info.album.id}]` : ''}`
        : null;
    const position =
        info.trackNumber != null
            ? `${info.volumeNumber ?? 1}.${info.trackNumber}`
            : null;
    const modes = info.audioModes.length ? info.audioModes.join(', ') : null;
    const tags = info.mediaTags.length ? info.mediaTags.join(', ') : null;

    return joinLines([
        header,
        line('Title', info.title),
        info.version ? line('Version', info.version) : null,
        line('Artist', artists),
        line('Album', albumStr),
        line('Position', position),
        line('Duration', info.durationFormatted),
        line('Quality', info.audioQuality),
        line('Audio Modes', modes),
        line('Media Tags', tags),
        info.explicit ? line('Explicit', 'yes') : null,
        line('ISRC', info.isrc),
        line('Copyright', info.copyright),
        line('Released', info.streamStartDate),
        line('URL', info.url),
    ]);
}

export function formatAlbumText(info: AlbumInfoJson, { showTracks }: { showTracks: boolean }): string {
    const header = `Album ${info.id}: ${info.title ?? '(untitled)'}`;
    const artists =
        info.artists.length > 1 ? info.artists.join(', ') : info.artist || null;
    const counts = `${info.numberOfTracks} track${info.numberOfTracks === 1 ? '' : 's'}` +
        (info.numberOfVolumes > 1 ? ` across ${info.numberOfVolumes} discs` : '');
    const modes = info.audioModes.length ? info.audioModes.join(', ') : null;

    const lines = [
        header,
        line('Artist', artists),
        line('Tracks', counts),
        line('Duration', info.durationFormatted),
        line('Released', info.releaseDate),
        line('Quality', info.audioQuality),
        line('Audio Modes', modes),
        line('Copyright', info.copyright),
        line('UPC', info.upc),
        line('URL', info.url),
    ];

    if (showTracks && info.tracks.length > 0) {
        lines.push('  Tracks:');
        for (const t of info.tracks) {
            const pos =
                t.trackNumber != null
                    ? `${t.volumeNumber ?? 1}.${String(t.trackNumber).padStart(2, '0')}`
                    : '?.??';
            const dur = t.durationFormatted ? `(${t.durationFormatted})` : '';
            const artist = t.artists.length > 1 ? t.artists.join(', ') : t.artist || '';
            const quality = t.audioQuality ? ` [${t.audioQuality}]` : '';
            const segs = [pos, t.displayTitle];
            if (artist) segs.push(`— ${artist}`);
            const tail = [quality, dur ? ` ${dur}` : ''].join('');
            lines.push(`    ${segs.join('  ')}${tail}`);
        }
    }

    return joinLines(lines);
}
