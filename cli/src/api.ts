import { cacheGet, cacheSet } from './cache.js';
import { log } from './log.js';
import { proxyPool } from './proxy.js';
import type { Instances } from './instances.js';
import { buildTidalCoverUrl } from '#js/tidal-urls.ts';
// @ts-expect-error - JS module without full types
import { deezerFallbackSettings } from '#js/storage.js';
// @ts-expect-error - JS module without full types
import { normalizeQualityToken } from '#js/utils.js';
import { HiFiClient } from '#js/HiFi.ts';
import { createUnifiedClient, type UnifiedClientOptions } from './unified.js';

export interface FetchOpts {
    signal?: AbortSignal;
    type?: 'api' | 'streaming';
}

/**
 * Fetch from API instances with retry and fallback.
 */
export async function fetchWithRetry(
    instances: Instances,
    relativePath: string,
    { signal, type = 'api' }: FetchOpts = {}
): Promise<Response> {
    // Mirror upstream: try Tidal's native API first for non-streaming metadata.
    if (type !== 'streaming') {
        try {
            return await HiFiClient.instance.query(relativePath);
        } catch (err) {
            const msg = (err as Error).message;
            if (msg.includes('not initialized')) {
                log.verbose('  Native Tidal API unavailable (HiFiClient not initialized); using instances');
            } else {
                log.verbose(`  Native Tidal API failed, falling back to instances: ${msg}`);
            }
        }
    }

    const list = type === 'streaming' ? instances.streaming : instances.api;
    if (!list || list.length === 0) throw new Error(`No ${type} instances configured`);

    let lastError: Error | null = null;
    const maxAttempts = list.length * 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const baseUrl = list[attempt % list.length];
        const url = baseUrl.endsWith('/')
            ? `${baseUrl}${relativePath.startsWith('/') ? relativePath.substring(1) : relativePath}`
            : `${baseUrl}${relativePath.startsWith('/') ? '' : '/'}${relativePath}`;

        try {
            log.verbose(`  → ${url}`);
            const response = await fetch(url, { signal });

            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('Retry-After') || '3', 10);
                if (proxyPool.size > 1) {
                    proxyPool.markRateLimited(retryAfter, 'tidal');
                    const waitMs = proxyPool.rotate('tidal');
                    if (waitMs > 0) {
                        log.verbose(`  All proxies rate-limited, waiting ${Math.ceil(waitMs / 1000)}s...`);
                        await new Promise((r) => setTimeout(r, waitMs));
                    }
                } else {
                    log.verbose(`  Rate limited, waiting ${retryAfter}s...`);
                    await new Promise((r) => setTimeout(r, retryAfter * 1000));
                }
                continue;
            }

            if (response.ok) return response;

            if (response.status === 401) {
                log.verbose(`  401 from ${baseUrl}, trying next instance...`);
                lastError = new Error(`Unauthorized: ${response.status}`);
                continue;
            }

            if (response.status >= 500) {
                log.verbose(`  ${response.status} from ${baseUrl}, trying next...`);
                lastError = new Error(`Server error: ${response.status}`);
                continue;
            }

            // 404 — resource genuinely not found, don't retry other instances
            if (response.status === 404) {
                const text = await response.text().catch(() => '');
                throw new Error(`Not found (404): ${text}`);
            }

            // Other 4xx — likely a real error
            const text = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${text}`);
        } catch (err: unknown) {
            const e = err as Error;
            if (e.name === 'AbortError') throw err;
            // Propagate 404 immediately — no point retrying other instances
            if (e.message?.startsWith('Not found (404)')) throw err;
            lastError = e;
            log.verbose(`  Error from ${baseUrl}: ${e.message}`);
        }
    }

    throw lastError || new Error(`All instances failed for: ${relativePath}`);
}

/**
 * Extract stream URL from a manifest (base64 JSON or raw JSON).
 */
export function extractStreamUrlFromManifest(manifest: unknown): string | null {
    if (!manifest) return null;

    try {
        let decoded: string | null = null;
        if (typeof manifest === 'string') {
            try {
                decoded = Buffer.from(manifest, 'base64').toString('utf-8');
            } catch {
                decoded = manifest;
            }
        } else if (typeof manifest === 'object' && manifest !== null) {
            const m = manifest as { urls?: string[] };
            if (m.urls && Array.isArray(m.urls)) {
                const priorityKeywords = ['flac', 'lossless', 'hi-res', 'high'];
                const sorted = [...m.urls].sort((a, b) => {
                    const aLow = a.toLowerCase();
                    const bLow = b.toLowerCase();
                    const aScore = priorityKeywords.findIndex((k) => aLow.includes(k));
                    const bScore = priorityKeywords.findIndex((k) => bLow.includes(k));
                    return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
                });
                return sorted[0];
            }
            if (m.urls?.[0]) return m.urls[0];
            return null;
        } else {
            return null;
        }

        if (decoded == null) return null;

        // Try parsing as JSON
        try {
            const json = JSON.parse(decoded) as { urls?: string[]; url?: string };
            if (json.urls && Array.isArray(json.urls)) {
                return json.urls[0];
            }
            if (json.url) return json.url;
        } catch {
            // Not JSON; check if it's an MPD/DASH manifest
            if (decoded.includes('<MPD') || decoded.includes('<?xml')) {
                const baseUrlMatch = decoded.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/);
                if (baseUrlMatch) return baseUrlMatch[1];
            }
            // Maybe it's just a direct URL
            if (decoded.startsWith('http')) return decoded.trim();
        }
    } catch (error) {
        log.verbose(`Failed to decode manifest: ${(error as Error).message}`);
    }

    return null;
}

export interface Track {
    id: string | number;
    title: string;
    version?: string | null;
    trackNumber?: number;
    volumeNumber?: number;
    duration?: number;
    isrc?: string | null;
    explicit?: boolean;
    artist?: Artist | null;
    artists?: Artist[];
    album?: AlbumSummary | null;
    audioQuality?: string | null;
    audioModes?: string[];
    mediaMetadata?: unknown;
    streamReady?: boolean;
    allowStreaming?: boolean;
    streamStartDate?: string | null;
    copyright?: string | null;
    url?: string | null;
}

export interface Artist {
    id?: string | number;
    name?: string;
}

export interface AlbumSummary {
    id?: string | number;
    title?: string;
    cover?: string;
    releaseDate?: string | null;
    artist?: Artist;
    artists?: Artist[];
    numberOfTracks?: number;
    numberOfVolumes?: number;
    upc?: string;
    copyright?: string | null;
    url?: string | null;
}

export interface Album extends AlbumSummary {
    id: string | number;
    title: string;
    numberOfTracks: number;
    numberOfVolumes: number;
    duration: number;
    releaseDate: string | null;
    cover: string | null;
    upc: string | null;
    audioQuality: string | null;
    audioModes: string[];
    copyright: string | null;
    url: string | null;
    artist: Artist | null;
    artists: Artist[];
}

export interface RgInfo {
    trackReplayGain?: number;
    trackPeakAmplitude?: number;
    albumReplayGain?: number;
    albumPeakAmplitude?: number;
}

export interface StreamResult {
    url: string;
    rgInfo: RgInfo | null;
    /** Source/provider when known (unified/deezer/etc.). */
    provider?: string;
    /** Stream packaging type. */
    playbackType?: 'direct' | 'dash' | 'hls' | 'dash-cenc';
    /** Audio MIME type when known. */
    mimeType?: string;
    /** Detected codec when known. */
    codec?: string | null;
    /** Original container when known. */
    container?: string | null;
    /** Amazon CENC decryption key (hex). */
    decryptionKey?: string;
    /** Amazon CENC key ID (hex). */
    keyId?: string;
}

const DEEZER_FORMAT_MAP: Record<string, string> = {
    HI_RES_LOSSLESS: 'FLAC',
    LOSSLESS: 'FLAC',
    HIGH: 'MP3_320',
    LOW: 'MP3_128',
    NORMAL: 'MP3_128',
};

/** Mirrors `getDeezerStreamFormat` in `js/api.js`. */
export function getDeezerStreamFormat(quality = 'LOSSLESS'): string {
    return DEEZER_FORMAT_MAP[quality] || DEEZER_FORMAT_MAP[normalizeQualityToken(quality)] || 'FLAC';
}

/**
 * Resolve a stream URL from the Deezer fallback service by ISRC.
 *
 * Mirrors `getDeezerStreamUrl` in `js/api.js`, including its tolerance for
 * services that reject HEAD (405/501). The endpoint and the enabled flag come
 * from `deezerFallbackSettings` so the CLI tracks the web app's defaults.
 */
export async function getDeezerStreamUrl(isrc: string, quality = 'LOSSLESS'): Promise<StreamResult | null> {
    if (!isrc || !deezerFallbackSettings.isEnabled()) return null;

    const baseUrl = String(deezerFallbackSettings.getApiBaseUrl() || '').replace(/\/+$/, '');
    if (!baseUrl) return null;

    const format = getDeezerStreamFormat(quality);
    const url = `${baseUrl}/stream/?isrc=${encodeURIComponent(isrc)}&format=${encodeURIComponent(format)}`;

    try {
        log.verbose(`  Deezer lookup (ISRC ${isrc}) → ${baseUrl}`);
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(12000) });
        if (!res.ok && res.status !== 405 && res.status !== 501) return null;
    } catch (err) {
        log.verbose(`  Deezer fallback failed: ${(err as Error).message}`);
        return null;
    }

    return { url, rgInfo: null, provider: 'deezer', playbackType: 'direct' };
}

/**
 * Legacy fallback: query a HiFi instance's /trackManifests endpoint and, if
 * that fails, try the /info endpoint's originalTrackUrl or embedded manifest.
 */
async function getTrackManifestsStream(
    instances: Instances,
    id: string | number,
    quality: string,
    download: boolean,
    lookup: { track: Track; info: unknown; originalTrackUrl: string | null }
): Promise<StreamResult | null> {
    const buildParams = (): URLSearchParams => {
        const paramsArray: [string, string][] = [];
        if (quality === 'LOW') {
            paramsArray.push(['formats', 'HEAACV1']);
        } else if (quality === 'HIGH') {
            paramsArray.push(['formats', 'HEAACV1']);
            paramsArray.push(['formats', 'AACLC']);
        } else if (quality === 'LOSSLESS') {
            paramsArray.push(['formats', 'HEAACV1']);
            paramsArray.push(['formats', 'AACLC']);
            paramsArray.push(['formats', 'FLAC']);
        } else if (quality === 'HI_RES_LOSSLESS') {
            paramsArray.push(['formats', 'HEAACV1']);
            paramsArray.push(['formats', 'AACLC']);
            paramsArray.push(['formats', 'FLAC_HIRES']);
            paramsArray.push(['formats', 'FLAC']);
        } else if (quality === 'DOLBY_ATMOS') {
            paramsArray.push(['formats', 'EAC3_JOC']);
        } else {
            paramsArray.push(['formats', 'HEAACV1']);
            paramsArray.push(['formats', 'AACLC']);
            paramsArray.push(['formats', 'FLAC']);
            paramsArray.push(['formats', 'FLAC_HIRES']);
            if (download) paramsArray.push(['formats', 'EAC3_JOC']);
        }
        paramsArray.push(['adaptive', 'true'], ['manifestType', 'MPEG_DASH'], ['uriScheme', 'HTTPS'], ['usage', 'PLAYBACK']);
        return new URLSearchParams(paramsArray);
    };

    try {
        const response = await fetchWithRetry(
            instances,
            `/trackManifests/?id=${id}&${buildParams().toString()}`,
            { type: 'streaming' }
        );
        const jsonResponse = (await response.json()) as any;
        const url = jsonResponse?.data?.data?.attributes?.uri;
        if (url) {
            const attrs = jsonResponse?.data?.data?.attributes;
            return {
                url,
                rgInfo: {
                    trackReplayGain: attrs?.trackAudioNormalizationData?.replayGain,
                    trackPeakAmplitude: attrs?.trackAudioNormalizationData?.peakAmplitude,
                    albumReplayGain: attrs?.albumAudioNormalizationData?.replayGain,
                    albumPeakAmplitude: attrs?.albumAudioNormalizationData?.peakAmplitude,
                },
                provider: 'hifi',
                playbackType: 'dash',
            };
        }
    } catch {
        /* fall through to /info fallback */
    }

    if (lookup.originalTrackUrl) {
        return { url: lookup.originalTrackUrl, rgInfo: null, provider: 'tidal', playbackType: 'direct' };
    }

    const extracted = extractStreamUrlFromManifest((lookup.info as any)?.manifest);
    if (extracted) {
        const info = lookup.info as any;
        return {
            url: extracted,
            rgInfo: {
                trackReplayGain: info.trackReplayGain || info.replayGain,
                trackPeakAmplitude: info.trackPeakAmplitude || info.peakAmplitude,
                albumReplayGain: info.albumReplayGain,
                albumPeakAmplitude: info.albumPeakAmplitude,
            },
            provider: 'tidal',
            playbackType: extracted.includes('.mpd') ? 'dash' : 'direct',
        };
    }

    return null;
}

export interface ApiClient {
    getTrack(id: string | number, quality?: string): Promise<{ track: Track; info: unknown; originalTrackUrl: string | null }>;
    getAlbum(id: string | number): Promise<{ album: Album; tracks: Track[] }>;
    getStreamUrl(id: string | number, quality?: string, download?: boolean): Promise<StreamResult>;
    getCoverUrl(coverId: string | null, size?: string): string | null;
    prepareTrack(raw: any): Track;
    prepareAlbum(raw: any): Album;
}

/**
 * Create a TidalAPI client bound to specific instances with optional caching.
 */
export function createApiClient(
    instances: Instances,
    { useCache = true, unified }: { useCache?: boolean; unified?: UnifiedClientOptions } = {}
): ApiClient {
    const streamCache = new Map<string, StreamResult>();
    const unifiedClient = createUnifiedClient(unified);

    async function apiGet<T = any>(path: string, opts: FetchOpts = {}): Promise<T> {
        const response = await fetchWithRetry(instances, path, opts);
        return (await response.json()) as T;
    }

    async function cachedApiGet<T = any>(namespace: string, id: string | number, path: string, opts: FetchOpts = {}): Promise<T> {
        if (useCache) {
            const cached = await cacheGet<T>(namespace, id);
            if (cached) {
                log.verbose(`  Cache hit: ${namespace}/${id}`);
                return cached;
            }
        }

        const data = await apiGet<T>(path, opts);
        if (useCache) {
            await cacheSet(namespace, id, data);
        }
        return data;
    }

    function prepareTrack(raw: any): Track {
        const item = raw.item || raw.resource || raw;
        return {
            id: item.id,
            title: item.title,
            version: item.version || null,
            trackNumber: item.trackNumber,
            volumeNumber: item.volumeNumber || 1,
            duration: item.duration,
            isrc: item.isrc || null,
            explicit: item.explicit || false,
            artist: item.artist || item.artists?.[0] || null,
            artists: item.artists || (item.artist ? [item.artist] : []),
            album: item.album || null,
            audioQuality: item.audioQuality || null,
            audioModes: item.audioModes || [],
            mediaMetadata: item.mediaMetadata || null,
            streamReady: item.streamReady ?? true,
            allowStreaming: item.allowStreaming ?? true,
            streamStartDate: item.streamStartDate || null,
            copyright: item.copyright || null,
            url: item.url || null,
        };
    }

    function prepareAlbum(raw: any): Album {
        const item = raw.resource || raw;
        return {
            id: item.id,
            title: item.title,
            artist: item.artist || item.artists?.[0] || null,
            artists: item.artists || [],
            numberOfTracks: item.numberOfTracks || 0,
            numberOfVolumes: item.numberOfVolumes || 1,
            duration: item.duration || 0,
            releaseDate: item.releaseDate || null,
            cover: item.cover || null,
            upc: item.upc || null,
            audioQuality: item.audioQuality || null,
            audioModes: item.audioModes || [],
            copyright: item.copyright || null,
            url: item.url || null,
        };
    }

    return {
        async getTrack(id, _quality = 'HI_RES_LOSSLESS') {
            const data = await cachedApiGet<any>('track_info', id, `/info/?id=${id}`);
            const unwrapped = data.data || data;

            if (!unwrapped || !unwrapped.id) {
                throw new Error(`Track not found: ${id}`);
            }

            const track = prepareTrack(unwrapped);

            const info = {
                manifest: null,
                audioQuality: unwrapped.audioQuality || null,
                trackReplayGain: unwrapped.replayGain ?? null,
                trackPeakAmplitude: unwrapped.peak ?? null,
            };

            return {
                track,
                info,
                originalTrackUrl: unwrapped.OriginalTrackUrl || unwrapped.originalTrackUrl || null,
            };
        },

        async getAlbum(id) {
            const data = await cachedApiGet<any>('album', id, `/album/?id=${id}`);
            const unwrapped = data.data || data;

            let album: Album | null = null;
            let tracksSection: any = null;

            if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
                if ('numberOfTracks' in unwrapped || 'title' in unwrapped) {
                    album = prepareAlbum(unwrapped);
                }
                if ('items' in unwrapped) {
                    tracksSection = unwrapped;
                    if (!album && unwrapped.items?.length > 0) {
                        const firstItem = unwrapped.items[0];
                        const t = firstItem.item || firstItem;
                        if (t?.album) album = prepareAlbum(t.album);
                    }
                }
            }

            if (!album) throw new Error(`Album not found: ${id}`);

            if (!album.artist && tracksSection?.items?.length > 0) {
                const t = tracksSection.items[0].item || tracksSection.items[0];
                if (t?.artist) album.artist = t.artist;
            }

            if (!album.releaseDate && tracksSection?.items?.length > 0) {
                const t = tracksSection.items[0].item || tracksSection.items[0];
                if (t?.album?.releaseDate) album.releaseDate = t.album.releaseDate;
                else if (t?.streamStartDate) album.releaseDate = t.streamStartDate.split('T')[0];
            }

            let tracks: Track[] = (tracksSection?.items || []).map((i: any) => prepareTrack(i.item || i));

            // Handle pagination
            if (album.numberOfTracks > tracks.length) {
                let offset = tracks.length;
                while (tracks.length < album.numberOfTracks && tracks.length < 10000) {
                    try {
                        const nextData = await apiGet<any>(`/album/?id=${id}&offset=${offset}&limit=500`);
                        const nextUnwrapped = nextData.data || nextData;
                        let nextItems = nextUnwrapped.items || [];
                        if (!nextItems.length && Array.isArray(nextUnwrapped)) {
                            for (const entry of nextUnwrapped) {
                                if (entry?.items?.length) {
                                    nextItems = entry.items;
                                    break;
                                }
                            }
                        }
                        if (!nextItems.length) break;
                        const prepared = nextItems.map((i: any) => prepareTrack(i.item || i));
                        if (!prepared.length) break;
                        if (tracks.length > 0 && prepared[0].id === tracks[0].id) break;
                        tracks = tracks.concat(prepared);
                        offset += prepared.length;
                    } catch {
                        break;
                    }
                }
            }

            if (album.cover) {
                tracks = tracks.map((t) => {
                    if (t.album && !t.album.cover) {
                        return { ...t, album: { ...t.album, cover: album!.cover ?? undefined } };
                    } else if (!t.album) {
                        return { ...t, album: { cover: album!.cover ?? undefined } };
                    }
                    return t;
                });
            }

            if (album.releaseDate) {
                tracks = tracks.map((t) => {
                    if (t.album && !t.album.releaseDate) {
                        return { ...t, album: { ...t.album, releaseDate: album!.releaseDate } };
                    }
                    return t;
                });
            }

            return { album, tracks };
        },

        async getStreamUrl(id, quality = 'HI_RES_LOSSLESS', download = false) {
            const cacheKey = `stream_info_${id}_${quality}`;
            const cached = streamCache.get(cacheKey);
            if (cached) return cached;

            const lookup = await this.getTrack(id, quality);
            const isrc = lookup.track?.isrc;
            const intent = download ? 'download' : 'stream';
            let result: StreamResult | null = null;

            // 1. Unified Playback API (Amazon / Tidal / Mono). Requires a user
            //    token; the website's default token needs browser Turnstile.
            if (unifiedClient.isConfigured) {
                try {
                    result = await unifiedClient.getStreamUrl(lookup.track, quality, intent);
                } catch (err) {
                    log.verbose(`  Unified Playback failed: ${(err as Error).message}`);
                }
            }

            // 2. Deezer fallback by ISRC.
            if (!result && isrc) {
                log.verbose(`  Falling back to Deezer (ISRC ${isrc})`);
                result = await getDeezerStreamUrl(isrc, quality);
            }

            // 3. If the requested Deezer format wasn't lossless, retry lossless.
            if (!result && isrc) {
                const requestedFormat = getDeezerStreamFormat(quality);
                const losslessFormat = getDeezerStreamFormat('LOSSLESS');
                if (requestedFormat !== losslessFormat) {
                    log.verbose(`  Retrying Deezer with LOSSLESS`);
                    result = await getDeezerStreamUrl(isrc, 'LOSSLESS');
                }
            }

            // 4. Legacy HiFi instance trackManifests endpoint (last resort).
            if (!result) {
                log.verbose(`  Falling back to HiFi instance trackManifests`);
                result = await getTrackManifestsStream(instances, id, quality, download, lookup);
            }

            if (!result) {
                throw new Error(
                    isrc
                        ? `Could not resolve stream URL for track ${id}: Unified Playback, Deezer, and HiFi instances all failed`
                        : `Could not resolve stream URL for track ${id}: no ISRC available for Deezer fallback`
                );
            }

            streamCache.set(cacheKey, result);
            return result;
        },

        getCoverUrl(coverId, size = '1280') {
            return buildTidalCoverUrl(coverId, size);
        },

        prepareTrack,
        prepareAlbum,
    };
}
