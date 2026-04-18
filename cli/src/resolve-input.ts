import { log } from './log.js';
import { proxyPool } from './proxy.js';

const TIDAL_HOSTS = ['tidal.com', 'www.tidal.com', 'listen.tidal.com'];
const SONGLINK_MAX_RETRIES = 3;

export interface ResolvedInput {
    type: 'track' | 'album' | null;
    id: string;
    original: string;
    tidalUrl?: string;
}

/**
 * Parse a Tidal URL into { type, id }.
 *
 * Supported shapes:
 *   tidal.com/track/123
 *   tidal.com/track/123/u
 *   tidal.com/album/456
 *   tidal.com/album/456/track/789  → track 789
 *   listen.tidal.com/...
 */
export function parseTidalUrl(input: string): { type: 'track' | 'album'; id: string } | null {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        return null;
    }

    if (!TIDAL_HOSTS.includes(url.hostname)) return null;

    const segments = url.pathname.split('/').filter(Boolean);

    // tidal.com/album/456/track/789  → track
    const trackInAlbumIdx = segments.indexOf('track');
    if (trackInAlbumIdx !== -1 && segments[trackInAlbumIdx + 1]) {
        const id = segments[trackInAlbumIdx + 1];
        if (/^\d+$/.test(id)) return { type: 'track', id };
    }

    // tidal.com/track/123  or  tidal.com/track/123/u
    if (segments[0] === 'track' && segments[1] && /^\d+$/.test(segments[1])) {
        return { type: 'track', id: segments[1] };
    }

    // tidal.com/album/456
    if (segments[0] === 'album' && segments[1] && /^\d+$/.test(segments[1])) {
        return { type: 'album', id: segments[1] };
    }

    return null;
}

/**
 * Resolve a non-Tidal URL to a Tidal URL via the song.link API.
 */
export async function resolveViaSongLink(
    url: string,
    isSong: boolean = false
): Promise<{ type: 'track' | 'album'; id: string; tidalUrl: string }> {
    const params = new URLSearchParams({ url });
    if (isSong) params.set('songIfSingle', 'true');
    const endpoint = `https://api.song.link/v1-alpha.1/links?${params.toString()}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < SONGLINK_MAX_RETRIES; attempt++) {
        try {
            log.verbose(`  song.link → ${endpoint}`);
            const res = await fetch(endpoint);

            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
                if (proxyPool.size > 1) {
                    proxyPool.markRateLimited(retryAfter, 'songlink');
                    const waitMs = proxyPool.rotate('songlink');
                    if (waitMs > 0) {
                        log.verbose(
                            `  All proxies rate-limited for song.link, waiting ${Math.ceil(waitMs / 1000)}s...`
                        );
                        await new Promise((r) => setTimeout(r, waitMs));
                    }
                } else {
                    log.verbose(`  song.link rate limited, waiting ${retryAfter}s...`);
                    await new Promise((r) => setTimeout(r, retryAfter * 1000));
                }
                continue;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`song.link returned HTTP ${res.status}: ${text}`);
            }

            const data = (await res.json()) as { linksByPlatform?: { tidal?: { url?: string } } };
            const tidalUrl = data?.linksByPlatform?.tidal?.url;
            if (!tidalUrl) {
                throw new Error(`No Tidal equivalent found for ${url}`);
            }

            const parsed = parseTidalUrl(tidalUrl);
            if (!parsed) {
                throw new Error(`song.link returned an unrecognised Tidal URL: ${tidalUrl}`);
            }
            return { ...parsed, tidalUrl };
        } catch (err) {
            const msg = (err as Error).message;
            if (msg?.startsWith('No Tidal equivalent') || msg?.startsWith('song.link returned an unrecognised')) {
                throw err;
            }
            lastError = err as Error;
            log.verbose(`  song.link attempt ${attempt + 1} failed: ${msg}`);
        }
    }

    throw lastError || new Error(`song.link resolution failed for ${url}`);
}

/**
 * Determine whether an input string looks like a URL.
 */
function isUrl(input: string): boolean {
    return /^https?:\/\//i.test(input);
}

/**
 * Resolve a single CLI input to { type, id, original }.
 *
 * - Bare integer → { type: null, id } (auto-detect later via API)
 * - Tidal URL → parsed directly
 * - Other URL → resolved via song.link
 */
export async function resolveInput(input: string): Promise<ResolvedInput> {
    // Bare integer
    if (/^\d+$/.test(input)) {
        return { type: null, id: input, original: input };
    }

    // URL
    if (isUrl(input)) {
        const tidal = parseTidalUrl(input);
        if (tidal) {
            return { ...tidal, original: input };
        }

        const resolved = await resolveViaSongLink(input);
        return { ...resolved, original: input };
    }

    throw new Error(`Unrecognised input: ${input} (expected a Tidal ID, Tidal URL, or music service URL)`);
}

/**
 * Resolve all CLI inputs, collecting successes and failures.
 */
export async function resolveAllInputs(
    inputs: string[]
): Promise<{ resolved: ResolvedInput[]; errors: { input: string; error: string }[] }> {
    const resolved: ResolvedInput[] = [];
    const errors: { input: string; error: string }[] = [];

    for (const input of inputs) {
        try {
            const result = await resolveInput(input);
            resolved.push(result);
            if (result.original !== result.id) {
                log.info(`  ${input} → ${result.type || 'auto'}:${result.id}`);
            }
        } catch (err) {
            errors.push({ input, error: (err as Error).message });
            log.error(`  Failed to resolve input: ${input} — ${(err as Error).message}`);
        }
    }

    return { resolved, errors };
}
