import { cacheGet, cacheSet } from './cache.js';
import { log } from './log.js';
import { proxyPool } from './proxy.js';
import type { Instances } from './instances.js';
import { TIDAL_CLIENT_ID as CLIENT_ID, TIDAL_CLIENT_SECRET as CLIENT_SECRET } from '#js/tidal-client-ids.ts';
import { buildTidalCoverUrl } from '#js/tidal-urls.ts';

let cachedToken: string | null = null;
let tokenExpiry = 0;

/**
 * Obtain an OAuth2 client_credentials token from Tidal.
 */
export async function getToken({ force = false }: { force?: boolean } = {}): Promise<string> {
    if (!force && cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'client_credentials',
    });

    const res = await fetch('https://auth.tidal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        },
        body: params,
    });

    if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
    return cachedToken;
}

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
    artist?: { name?: string } | null;
    artists?: { name?: string }[];
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

export interface AlbumSummary {
    id?: string | number;
    title?: string;
    cover?: string;
    releaseDate?: string | null;
    artist?: { name?: string };
    artists?: { name?: string }[];
    numberOfTracks?: number;
    numberOfVolumes?: number;
    upc?: string;
    copyright?: string | null;
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
    artist: { name?: string } | null;
    artists: { name?: string }[];
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
export function createApiClient(instances: Instances, { useCache = true }: { useCache?: boolean } = {}): ApiClient {
    const streamCache = new Map<string, StreamResult>();

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

            let streamUrl: string | undefined;
            let rgInfo: RgInfo | null = null;
            let isUsingManifestEndpoint = false;

            try {
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

                paramsArray.push(
                    ['adaptive', 'true'],
                    ['manifestType', 'MPEG_DASH'],
                    ['uriScheme', 'HTTPS'],
                    ['usage', 'PLAYBACK']
                );

                const params = new URLSearchParams(paramsArray);
                const response = await fetchWithRetry(
                    instances,
                    `/trackManifests/?id=${id}&${params.toString()}`,
                    { type: 'streaming' }
                );
                const jsonResponse = (await response.json()) as any;
                const url = jsonResponse?.data?.data?.attributes?.uri;
                if (url) {
                    streamUrl = url;
                    const attrs = jsonResponse?.data?.data?.attributes;
                    rgInfo = {
                        trackReplayGain: attrs?.trackAudioNormalizationData?.replayGain,
                        trackPeakAmplitude: attrs?.trackAudioNormalizationData?.peakAmplitude,
                        albumReplayGain: attrs?.albumAudioNormalizationData?.replayGain,
                        albumPeakAmplitude: attrs?.albumAudioNormalizationData?.peakAmplitude,
                    };
                    isUsingManifestEndpoint = true;
                } else {
                    throw new Error('No URI in trackManifests response');
                }
            } catch {
                // Fallback to /track endpoint
            }

            if (!isUsingManifestEndpoint) {
                const lookup = await this.getTrack(id, quality);
                if (lookup.originalTrackUrl) {
                    streamUrl = lookup.originalTrackUrl;
                } else {
                    const extracted = extractStreamUrlFromManifest((lookup.info as any)?.manifest);
                    if (!extracted) throw new Error('Could not resolve stream URL');
                    streamUrl = extracted;
                }
                const info = lookup.info as any;
                if (info) {
                    rgInfo = {
                        trackReplayGain: info.trackReplayGain || info.replayGain,
                        trackPeakAmplitude: info.trackPeakAmplitude || info.peakAmplitude,
                        albumReplayGain: info.albumReplayGain,
                        albumPeakAmplitude: info.albumPeakAmplitude,
                    };
                }
            }

            if (!streamUrl) throw new Error('Could not resolve stream URL');
            const result: StreamResult = { url: streamUrl, rgInfo };
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
