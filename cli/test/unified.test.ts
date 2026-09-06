import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUnifiedClient } from '../src/unified.js';
import type { Track } from '../src/api.js';

const baseTrack: Track = {
    id: 491206012,
    title: 'Never Gonna Give You Up',
    duration: 214,
    isrc: 'GBARL9300135',
    audioQuality: 'LOSSLESS',
    audioModes: ['STEREO'],
    artist: { id: 1, name: 'Rick Astley' },
    artists: [{ id: 1, name: 'Rick Astley' }],
    album: { id: 75413011, title: 'Whenever You Need Somebody' },
};

function envelope(source: string, resource: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
        schema_version: '2.0',
        request_id: 'req-1',
        selected_source: source,
        track: {
            id: source === 'amazon' ? 'B000000000' : 'mono-track',
            title: baseTrack.title,
            artists: [baseTrack.artist!.name],
            album: baseTrack.album!.title,
            isrc: baseTrack.isrc,
            duration_ms: (baseTrack.duration || 0) * 1000,
        },
        playback: [resource],
        sources: [],
        ...extra,
    };
}

describe('UnifiedClient', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns null when disabled', async () => {
        const client = createUnifiedClient({ enabled: false, token: 'abc' });
        const result = await client.getStreamUrl(baseTrack, 'HI_RES_LOSSLESS', 'download');
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null when no token is provided', async () => {
        const client = createUnifiedClient({ enabled: true });
        const result = await client.getStreamUrl(baseTrack, 'HI_RES_LOSSLESS', 'download');
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves Mono direct FLAC', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () =>
                envelope('mono', {
                    source: 'mono',
                    kind: 'audio',
                    delivery: 'direct',
                    url: 'https://cdn.example/track.flac',
                    mime_type: 'audio/flac',
                    quality: 'HI_RES_LOSSLESS',
                    codec: 'flac',
                    lossless: true,
                }),
        });

        const client = createUnifiedClient({ enabled: true, token: 'tok', baseUrl: 'https://u.example' });
        const result = await client.getStreamUrl(baseTrack, 'HI_RES_LOSSLESS', 'download');

        expect(result).not.toBeNull();
        expect(result?.provider).toBe('monochrome');
        expect(result?.playbackType).toBe('direct');
        expect(result?.url).toBe('https://cdn.example/track.flac');
        expect(result?.codec).toBe('flac');
        expect(result?.decryptionKey).toBeUndefined();
    });

    it('resolves Amazon CENC and extracts key + keyId', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () =>
                envelope('amazon', {
                    source: 'amazon',
                    kind: 'audio',
                    delivery: 'direct',
                    url: 'https://cdn.example/track.mp4',
                    mime_type: 'audio/mp4',
                    quality: 'UHD_HIGH',
                    codec: 'flac',
                    lossless: true,
                    decryption_key: '00112233445566778899aabbccddeeff',
                    encryption: { key_id: 'aabbccddeeff00112233445566778899' },
                }),
        });

        const client = createUnifiedClient({ enabled: true, token: 'tok' });
        const result = await client.getStreamUrl(baseTrack, 'HI_RES_LOSSLESS', 'download');

        expect(result).not.toBeNull();
        expect(result?.provider).toBe('amazon');
        expect(result?.playbackType).toBe('direct');
        expect(result?.decryptionKey).toBe('00112233445566778899aabbccddeeff');
        expect(result?.keyId).toBe('aabbccddeeff00112233445566778899');
        expect(result?.codec).toBe('flac');
    });

    it('resolves Tidal DASH manifest', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () =>
                envelope('tidal', {
                    source: 'tidal',
                    kind: 'manifest',
                    delivery: 'dash',
                    url: 'https://cdn.example/manifest.mpd',
                    mime_type: 'application/dash+xml',
                    quality: 'LOSSLESS',
                }),
        });

        const client = createUnifiedClient({ enabled: true, token: 'tok' });
        const result = await client.getStreamUrl(baseTrack, 'LOSSLESS', 'download');

        expect(result).not.toBeNull();
        expect(result?.provider).toBe('tidal');
        expect(result?.playbackType).toBe('dash');
        expect(result?.url).toBe('https://cdn.example/manifest.mpd');
    });

    it('rejects unsupported sources', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () =>
                envelope('soundcloud', {
                    source: 'soundcloud',
                    kind: 'audio',
                    delivery: 'direct',
                    url: 'https://cdn.example/track.mp3',
                }),
        });

        const client = createUnifiedClient({ enabled: true, token: 'tok' });
        await expect(client.getStreamUrl(baseTrack, 'LOSSLESS', 'download')).rejects.toThrow(
            'unsupported source'
        );
    });

    it('returns null on 401/403/428 without throwing', async () => {
        for (const status of [401, 403, 428]) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });
            const client = createUnifiedClient({ enabled: true, token: 'tok' });
            const result = await client.getStreamUrl(baseTrack, 'LOSSLESS', 'download');
            expect(result).toBeNull();
        }
    });

    it('returns null on 404/502', async () => {
        for (const status of [404, 502]) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });
            const client = createUnifiedClient({ enabled: true, token: 'tok' });
            const result = await client.getStreamUrl(baseTrack, 'LOSSLESS', 'download');
            expect(result).toBeNull();
        }
    });

    it('returns null and marks rate-limited on 429', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '5' : null) },
            json: async () => ({}),
        });

        const client = createUnifiedClient({ enabled: true, token: 'tok' });
        const result = await client.getStreamUrl(baseTrack, 'LOSSLESS', 'download');
        expect(result).toBeNull();
    });

    it('throws on unsupported schema version', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ schema_version: '3.0', playback: [{ url: 'x', kind: 'audio', delivery: 'direct' }] }),
        });

        const client = createUnifiedClient({ enabled: true, token: 'tok' });
        await expect(client.getStreamUrl(baseTrack, 'LOSSLESS', 'download')).rejects.toThrow(
            'schema version'
        );
    });
});
