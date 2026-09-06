import { log } from './log.js';
import { proxyPool } from './proxy.js';
import type { Track, StreamResult } from './api.js';
// @ts-expect-error - JS module without full types
import { unifiedPlaybackSettings } from '#js/storage.js';
// @ts-expect-error - JS module without full types
import { normalizeQualityToken, isAtmosQuality } from '#js/utils.js';

export interface UnifiedClientOptions {
    enabled?: boolean;
    token?: string;
    baseUrl?: string;
}

export interface UnifiedStreamResult extends StreamResult {
    provider: 'amazon' | 'tidal' | 'monochrome' | 'deezer';
    playbackType: 'direct' | 'dash' | 'hls' | 'dash-cenc';
    mimeType: string;
    codec: string | null;
    container: string | null;
    lossless: boolean | null;
    quality: string;
    decryptionKey?: string;
    keyId?: string;
}

interface UnifiedResource {
    url: string;
    kind?: string;
    delivery?: string;
    mime_type?: string;
    quality?: string;
    codec?: string;
    container?: string;
    lossless?: boolean;
    sample_rate_hz?: number;
    bit_depth?: number;
    bitrate_kbps?: number;
    channels?: number;
    channel_layout?: string;
    replay_gain?: unknown;
    encryption?: {
        key_id?: string;
        key?: { value?: string; id?: string };
    };
    decryption_key?: string;
    key_id?: string;
    [key: string]: unknown;
}

interface UnifiedEnvelope {
    schema_version?: string;
    request_id?: string;
    selected_source?: string;
    quality_requested?: string;
    intent?: string;
    track?: {
        id?: string | number;
        title?: string;
        artists?: string[];
        album?: string;
        isrc?: string;
        duration_ms?: number;
    };
    playback?: UnifiedResource[];
    sources?: unknown[];
}

function getTrackTitle(track: Track): string {
    return (track.title || '').trim();
}

function getTrackArtist(track: Track): string {
    if (track.artists && track.artists.length > 0) {
        return track.artists.map((a) => a.name).filter(Boolean).join(', ');
    }
    return track.artist?.name || '';
}

function getTrackAlbum(track: Track): string {
    return track.album?.title || '';
}

function getTrackDurationSec(track: Track): number | null {
    const d = Number(track.duration);
    if (!Number.isFinite(d) || d <= 0) return null;
    return d > 10000 ? d / 1000 : d;
}

function buildLookupParams(track: Track, quality: string, intent: string): URLSearchParams {
    const title = getTrackTitle(track);
    if (!title) throw new Error('Unified Playback lookup requires a track title');

    const params = new URLSearchParams({ track: title });
    const artist = getTrackArtist(track);
    const album = getTrackAlbum(track);
    const isrc = String(track.isrc || '').trim().toUpperCase();
    const duration = getTrackDurationSec(track);

    if (artist) params.set('artist', artist);
    if (album) params.set('album', album);
    if (isrc) params.set('isrc', isrc);
    if (duration) params.set('duration', String(Math.round(duration)));
    if (intent) params.set('intent', intent);

    const canonical = normalizeQualityToken(quality) || quality;
    if (canonical && canonical !== 'auto' && canonical !== 'ADAPTIVE') {
        params.set('quality', canonical);
    } else {
        params.set('quality', 'HI_RES_LOSSLESS');
    }

    return params;
}

function getDecryptionKey(resource: UnifiedResource): string | undefined {
    return (
        (resource.decryption_key as string) ||
        (resource.encryption?.key?.value as string) ||
        undefined
    );
}

function getKeyId(resource: UnifiedResource): string | undefined {
    return (
        (resource.key_id as string) ||
        (resource.encryption?.key_id as string) ||
        (resource.encryption?.key?.id as string) ||
        undefined
    );
}

function getCodec(resource: UnifiedResource): string | null {
    const source = String((resource.source as string | null | undefined) ?? '').toLowerCase();
    const quality = String(resource.quality || '').toUpperCase();
    if (quality.startsWith('DOLBY_ATMOS_AC4_')) return 'ac4';
    if (quality.startsWith('DOLBY_ATMOS_EAC3_') || quality === 'DOLBY_ATMOS') return 'eac3-joc';
    if (source === 'amazon' && /^(UHD|HD|HI_RES_LOSSLESS|LOSSLESS)(_|$)/.test(quality)) return 'flac';
    if (source === 'amazon' && /^(SD|HIGH|LOW)(_|$)/.test(quality)) return 'opus';
    return resource.codec?.toLowerCase() || null;
}

function getQualityInfo(resource: UnifiedResource) {
    return {
        codec: getCodec(resource),
        sampleRate: Number(
            resource.sample_rate_hz ?? resource.sampleRateHz ?? resource.sample_rate ?? resource.sampleRate
        ) || null,
        bitDepth: Number(resource.bit_depth ?? resource.bitDepth) || null,
        bitrateKbps: Number(resource.bitrate_kbps ?? resource.bitrateKbps) || null,
        bandwidth: Number(resource.bandwidth ?? resource.bitrate) || null,
        channels: Number(resource.channels) || null,
        channelLayout: resource.channel_layout ?? resource.channelLayout ?? null,
    };
}

function getReplayGain(resource: UnifiedResource) {
    const rg = (resource.replay_gain || resource.replayGain) as
        | Record<string, number | string | null | undefined>
        | undefined;
    if (!rg) return null;
    return {
        trackReplayGain: Number(rg.track_gain_db ?? rg.trackGainDb ?? 0) || 0,
        trackPeakAmplitude: Number(rg.track_peak ?? rg.trackPeak ?? 1) || 1,
        albumReplayGain: Number(rg.album_gain_db ?? rg.albumGainDb ?? 0) || 0,
        albumPeakAmplitude: Number(rg.album_peak ?? rg.albumPeak ?? 1) || 1,
    };
}

function isManifest(resource: UnifiedResource): boolean {
    return (
        resource.kind === 'manifest' ||
        resource.delivery === 'dash' ||
        resource.delivery === 'hls' ||
        (resource.mime_type &&
            (resource.mime_type.includes('dash') || resource.mime_type.includes('mpegurl'))) ||
        (typeof resource.url === 'string' &&
            (resource.url.includes('.mpd') ||
                resource.url.includes('.m3u8') ||
                resource.url.startsWith('data:application/dash+xml')))
    );
}

function selectResource(envelope: UnifiedEnvelope): UnifiedResource | null {
    if (!Array.isArray(envelope.playback)) return null;
    return (
        envelope.playback.find(
            (r) =>
                r &&
                typeof r.url === 'string' &&
                r.url &&
                (r.kind === 'audio' || r.kind === 'manifest') &&
                (r.delivery === 'direct' || r.delivery === 'dash' || r.delivery === 'hls')
        ) || null
    );
}

function isSupportedSource(source: string): source is 'amazon' | 'tidal' | 'monochrome' {
    return ['amazon', 'tidal', 'mono', 'monochrome'].includes(source);
}

export class UnifiedClient {
    private enabled: boolean;
    private token: string;
    private baseUrl: string;

    constructor(options: UnifiedClientOptions = {}) {
        this.enabled =
            options.enabled === undefined ? unifiedPlaybackSettings.isEnabled() : options.enabled;
        this.baseUrl =
            (options.baseUrl || unifiedPlaybackSettings.getApiBaseUrl() || '').replace(/\/+$/, '');
        this.token = (options.token || '').trim();
    }

    get isConfigured(): boolean {
        return this.enabled && Boolean(this.token);
    }

    /**
     * Resolve an audio stream through the Unified Playback API.
     *
     * Returns null when no token is configured or the track cannot be resolved,
     * and throws on hard failures (invalid schema, non-401/404/429 errors).
     */
    async getStreamUrl(
        track: Track,
        quality: string,
        intent: 'stream' | 'download' = 'download'
    ): Promise<UnifiedStreamResult | null> {
        if (!this.isConfigured) {
            log.verbose('  Unified Playback skipped: no user token configured');
            return null;
        }

        const atmosQuality = isAtmosQuality(quality) ? quality : null;
        const preferredAtmos = 'DOLBY_ATMOS_EAC3_HIGH';

        if (atmosQuality) {
            const result = await this._tryLookup(track, atmosQuality, intent);
            if (result) return result;
            log.verbose('  Unified Playback Atmos lookup failed; falling back to stereo');
        } else if (track.audioModes?.includes('DOLBY_ATMOS')) {
            const result = await this._tryLookup(track, preferredAtmos, intent);
            if (result) return result;
        }

        return this._tryLookup(track, quality, intent);
    }

    private async _tryLookup(
        track: Track,
        quality: string,
        intent: 'stream' | 'download'
    ): Promise<UnifiedStreamResult | null> {
        const params = buildLookupParams(track, quality, intent);
        const url = `${this.baseUrl}/api/v2/track/?${params.toString()}`;

        log.verbose(`  Unified Playback lookup → ${this.baseUrl}`);
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${this.token}`,
                },
                signal: AbortSignal.timeout(20000),
            });

            const envelope = (await response.json().catch(() => ({}))) as UnifiedEnvelope;

            if (response.status === 401 || response.status === 403 || response.status === 428) {
                log.verbose(
                    `  Unified Playback authorization failed (${response.status}); the default web token requires browser Turnstile. Provide a user token with --unified-token.`
                );
                return null;
            }

            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('Retry-After') || '3', 10);
                proxyPool.markRateLimited(retryAfter, 'unified');
                log.verbose(`  Unified Playback rate-limited, retry after ${retryAfter}s`);
                return null;
            }

            if (response.status === 404 || response.status === 502) {
                log.verbose('  Unified Playback could not resolve track');
                return null;
            }

            if (!response.ok) {
                throw new Error(`Unified Playback API failed: ${response.status}`);
            }

            const major = String(envelope.schema_version || '').split('.')[0];
            if (major !== '1' && major !== '2') {
                throw new Error(
                    `Unsupported Unified Playback schema version: ${envelope.schema_version || 'missing'}`
                );
            }

            const resource = selectResource(envelope);
            if (!resource) {
                log.verbose('  Unified Playback response contained no playable resources');
                return null;
            }

            let source = String(
                (envelope.selected_source as string | null | undefined) ||
                    (resource.source as string | null | undefined) ||
                    ''
            ).toLowerCase();
            if (!isSupportedSource(source)) {
                throw new Error(`Unified Playback selected an unsupported source: ${source || 'unknown'}`);
            }

            if (source === 'mono') source = 'monochrome';

            const qualityInfo = getQualityInfo(resource);
            const delivered =
                resource.quality || envelope.quality_requested || normalizeQualityToken(quality) || quality;
            const playbackType: UnifiedStreamResult['playbackType'] = isManifest(resource)
                ? resource.delivery === 'hls' || resource.url?.includes('.m3u8')
                    ? 'hls'
                    : 'dash'
                : 'direct';

            return {
                url: resource.url,
                provider: source as 'amazon' | 'tidal' | 'monochrome',
                playbackType,
                mimeType:
                    resource.mime_type ||
                    (playbackType === 'hls'
                        ? 'application/vnd.apple.mpegurl'
                        : playbackType === 'dash'
                          ? 'application/dash+xml'
                          : source === 'monochrome'
                            ? 'audio/flac'
                            : 'audio/mp4'),
                codec: qualityInfo.codec || resource.codec || null,
                container: resource.container || null,
                lossless: resource.lossless ?? null,
                quality: normalizeQualityToken(delivered) || delivered,
                rgInfo: getReplayGain(resource),
                decryptionKey: getDecryptionKey(resource),
                keyId: getKeyId(resource),
            };
        } catch (err) {
            const msg = (err as Error).message;
            if (msg.includes('aborted')) {
                log.verbose('  Unified Playback lookup timed out');
                return null;
            }
            throw err;
        }
    }
}

export function createUnifiedClient(options: UnifiedClientOptions): UnifiedClient {
    return new UnifiedClient(options);
}
