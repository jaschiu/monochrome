/**
 * HTTP client pool for the CLI. Issues all requests through curl-impersonate
 * via cuimp, providing TLS fingerprint diversity and optional SOCKS5 proxying.
 *
 * Overrides globalThis.fetch so every HTTP request routes through the
 * impersonated curl binary; proxy rotation is rate-limit-aware and per-service.
 */

import { log } from './log.js';
import type { CuimpHttp, CuimpOptions, CuimpRequestConfig } from 'cuimp';

type CreateCuimpHttpFn = typeof import('cuimp').createCuimpHttp;

let createCuimpHttp: CreateCuimpHttpFn | null = null;

async function ensureCuimp(): Promise<void> {
    if (createCuimpHttp) return;
    try {
        ({ createCuimpHttp } = await import('cuimp'));
    } catch {
        throw new Error('cuimp package is required.  Install:  npm i cuimp');
    }
}

const IMPERSONATE_TARGETS = [
    'chrome116',
    'chrome119',
    'chrome120',
    'chrome123',
    'chrome124',
    'chrome131',
    'chrome136',
    'firefox133',
    'firefox135',
    'firefox147',
    'edge99',
    'edge101',
];

const SILENT_LOGGER = {
    info() {},
    warn() {},
    error() {},
    debug() {},
};

function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

interface ProxyEntry {
    host: string;
    port: number;
    rateLimitedUntil: Map<string, number>;
}

/**
 * Wraps a cuimp stream response in a fetch-API-compatible Response-like object.
 */
class CuimpResponse {
    status: number;
    statusText: string;
    ok: boolean;
    private _rawBody: Buffer;
    private _headers: Record<string, string>;

    constructor(streamRes: { status: number; statusText?: string; rawBody?: Buffer; headers?: Record<string, string> }) {
        this.status = streamRes.status;
        this.statusText = streamRes.statusText || '';
        this.ok = this.status >= 200 && this.status < 300;
        this._rawBody = streamRes.rawBody || Buffer.alloc(0);
        this._headers = streamRes.headers || {};
    }

    get headers() {
        const h = this._headers;
        return {
            get(name: string): string | null {
                const lower = name.toLowerCase();
                for (const [k, v] of Object.entries(h)) {
                    if (k.toLowerCase() === lower) return v;
                }
                return null;
            },
            forEach(fn: (value: string, key: string) => void): void {
                for (const [k, v] of Object.entries(h)) fn(v, k);
            },
        };
    }

    async json<T = unknown>(): Promise<T> {
        return JSON.parse(this._rawBody.toString('utf-8')) as T;
    }

    async text(): Promise<string> {
        return this._rawBody.toString('utf-8');
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = this._rawBody;
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }
}

class ProxyPool {
    proxies: ProxyEntry[] = [];
    currentIndex = 0;
    private _client: CuimpHttp | null = null;
    private _currentTarget: string | null = null;
    private _originalFetch: typeof fetch | null = null;
    private _installed = false;

    /** Add a SOCKS5 endpoint to the pool. */
    add(host: string, port: number = 1080): void {
        this.proxies.push({ host, port: Number(port), rateLimitedUntil: new Map() });
    }

    get size(): number {
        return this.proxies.length;
    }

    get current(): ProxyEntry | null {
        if (!this.proxies.length) return null;
        return this.proxies[this.currentIndex % this.proxies.length];
    }

    /** Mark the current proxy as rate-limited for `seconds` on the given service. */
    markRateLimited(seconds: number = 10, service: string = 'default'): void {
        const p = this.current;
        if (!p) return;
        p.rateLimitedUntil.set(service, Date.now() + seconds * 1000);
        log.verbose(`  Proxy ${p.host}:${p.port} rate-limited for ${seconds}s [${service}]`);
    }

    /**
     * Rotate to the next non-rate-limited proxy for the given service.
     * Also switches browser identity.
     * @returns ms to wait if ALL proxies are rate-limited, or 0 on success.
     */
    rotate(service: string = 'default'): number {
        if (this.proxies.length <= 1) return 0;
        const now = Date.now();

        for (let i = 1; i <= this.proxies.length; i++) {
            const idx = (this.currentIndex + i) % this.proxies.length;
            if ((this.proxies[idx].rateLimitedUntil.get(service) || 0) <= now) {
                this.currentIndex = idx;
                this._rebuildClient();
                log.info(`  Rotated → ${this.proxies[idx].host}`);
                return 0;
            }
        }

        // All rate-limited — pick the one that expires soonest
        let minWait = Infinity;
        let minIdx = 0;
        for (let i = 0; i < this.proxies.length; i++) {
            const wait = (this.proxies[i].rateLimitedUntil.get(service) || 0) - now;
            if (wait < minWait) {
                minWait = wait;
                minIdx = i;
            }
        }
        this.currentIndex = minIdx;
        this._rebuildClient();
        return Math.max(minWait, 0);
    }

    /** Clear cookies on the current cuimp client. */
    clearCookies(): void {
        if (this._client && typeof (this._client as any).clearCookies === 'function') {
            (this._client as any).clearCookies();
        }
    }

    /** Switch to a new random browser identity (destroys + rebuilds cuimp client). */
    newIdentity(): void {
        this._rebuildClient();
    }

    /* ── internals ───────────────────────────────────────────── */

    private _pickTarget(): string {
        const available = IMPERSONATE_TARGETS.filter((t) => t !== this._currentTarget);
        return available[Math.floor(Math.random() * available.length)] || IMPERSONATE_TARGETS[0];
    }

    private _rebuildClient(): void {
        if (!createCuimpHttp) return; // deps not loaded yet
        if (this._client) {
            try {
                (this._client as any).destroy?.();
            } catch {
                /* ignore */
            }
            this._client = null;
        }
        this._currentTarget = this._pickTarget();
        const opts: CuimpOptions = {
            path: '/usr/bin/curl-impersonate',
            autoDownload: false,
            extraCurlArgs: ['--impersonate', this._currentTarget, '--compressed'],
            logger: SILENT_LOGGER,
        };
        const p = this.current;
        if (p) {
            opts.proxy = `socks5://${p.host}:${p.port}`;
        }
        this._client = createCuimpHttp(opts);
        log.verbose(`  cuimp identity: ${this._currentTarget}${p ? ` via ${p.host}:${p.port}` : ''}`);
    }

    /**
     * Perform a fetch-like request via the cuimp client.
     * Returns a CuimpResponse compatible with the fetch API surface we use.
     */
    private async _cuimpFetch(url: string | URL, opts: RequestInit & { signal?: AbortSignal } = {}): Promise<CuimpResponse> {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const method = (opts.method || 'GET').toUpperCase();
        const headers: Record<string, string> = {};

        if (opts.headers) {
            const h = opts.headers as any;
            if (typeof h.forEach === 'function') {
                h.forEach((v: string, k: string) => {
                    headers[k] = v;
                });
            } else {
                Object.assign(headers, h);
            }
        }

        const config: CuimpRequestConfig = { url: urlStr, method: method as any, headers };
        if (opts.body != null) {
            config.data = typeof opts.body === 'string' ? opts.body : (opts.body as any).toString();
        }
        if (opts.signal) {
            (config as any).signal = opts.signal;
        }

        const streamRes = await this._client!.requestStream(config, { collectBody: true });
        return new CuimpResponse(streamRes as any);
    }

    /**
     * Initialise cuimp, shuffle proxies (if any), override globalThis.fetch.
     */
    async install(): Promise<void> {
        if (this._installed) return;
        await ensureCuimp();

        if (this.proxies.length) {
            shuffle(this.proxies);
            this.currentIndex = 0;
        }
        this._rebuildClient();

        this._originalFetch = globalThis.fetch;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const pool = this;

        globalThis.fetch = function cuimpFetch(url: any, opts: any = {}): Promise<Response> {
            return pool._cuimpFetch(url, opts) as unknown as Promise<Response>;
        } as typeof fetch;

        this._installed = true;
        const p = this.current;
        if (p) {
            log.info(`SOCKS5 proxy: ${p.host}:${p.port} (pool: ${this.proxies.length})`);
        }
        log.info(`curl-impersonate: ${this._currentTarget}`);
    }
}

/** Singleton shared across the CLI. */
export const proxyPool = new ProxyPool();

/**
 * Fetch the Mullvad WireGuard relay list and populate `proxyPool` with
 * US-only SOCKS5 endpoints derived from each active relay's hostname.
 *
 * Relay hostname format:  `us-nyc-wg-001`
 * SOCKS5 hostname format: `us-nyc-wg-socks5-001.relays.mullvad.net:1080`
 */
export async function fetchMullvadRelays(): Promise<void> {
    log.info('Fetching Mullvad relay list...');
    const res = await fetch('https://api.mullvad.net/app/v1/relays');
    if (!res.ok) throw new Error(`Mullvad relays fetch failed: ${res.status}`);
    const data = (await res.json()) as { wireguard?: { relays?: any[] } };

    const relays = data?.wireguard?.relays;
    if (!Array.isArray(relays)) throw new Error('Unexpected Mullvad relay data format');

    let count = 0;
    for (const relay of relays) {
        if (!relay.active || !relay.hostname) continue;
        if (!(relay.hostname as string).startsWith('us-')) continue;

        const m = (relay.hostname as string).match(/^(.+)-wg-(\d+)$/);
        if (!m) continue;

        const socksHost = `${m[1]}-wg-socks5-${m[2]}.relays.mullvad.net`;
        proxyPool.add(socksHost, 1080);
        count++;
    }

    log.success(`${count} Mullvad US SOCKS5 relays loaded`);
    if (count === 0) throw new Error('No active Mullvad WireGuard relays found');
}
