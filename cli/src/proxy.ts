/**
 * SOCKS5 proxy pool with rate-limit-based rotation.
 *
 * Lazily loads `socks` (npm) and `undici` (bundled in Node 22+, or npm)
 * so the rest of the CLI works without those packages when proxying is not used.
 */

import tls from 'node:tls';
import { log } from './log.js';

type SocksClientType = typeof import('socks').SocksClient;
type UndiciAgentType = typeof import('undici').Agent;

let SocksClient: SocksClientType | null = null;
let UndiciAgent: UndiciAgentType | null = null;

async function ensureDeps(): Promise<void> {
    if (SocksClient && UndiciAgent) return;
    try {
        ({ SocksClient } = await import('socks'));
    } catch {
        throw new Error('SOCKS5 proxy requires the "socks" package.  Install:  npm i socks');
    }
    try {
        ({ Agent: UndiciAgent } = await import('undici'));
    } catch {
        throw new Error('SOCKS5 proxy requires Node.js 22+ or the "undici" package.');
    }
}

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

class ProxyPool {
    proxies: ProxyEntry[] = [];
    currentIndex = 0;
    private _dispatcher: InstanceType<UndiciAgentType> | null = null;
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
     * @returns ms to wait if ALL proxies are rate-limited, or 0 on success.
     */
    rotate(service: string = 'default'): number {
        if (this.proxies.length <= 1) return 0;
        const now = Date.now();

        for (let i = 1; i <= this.proxies.length; i++) {
            const idx = (this.currentIndex + i) % this.proxies.length;
            if ((this.proxies[idx].rateLimitedUntil.get(service) || 0) <= now) {
                this.currentIndex = idx;
                this._rebuildDispatcher();
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
        this._rebuildDispatcher();
        return Math.max(minWait, 0);
    }

    /* ── internals ───────────────────────────────────────────── */

    private _createDispatcher(host: string, port: number): InstanceType<UndiciAgentType> {
        if (!UndiciAgent || !SocksClient) throw new Error('Proxy deps not loaded');
        const socks = SocksClient;
        return new UndiciAgent({
            connect(opts: any, cb: (err: Error | null, socket?: any) => void) {
                const destPort = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);

                socks.createConnection({
                    proxy: { host, port, type: 5 },
                    command: 'connect',
                    destination: { host: opts.hostname, port: destPort },
                    timeout: 30_000,
                })
                    .then(({ socket }) => {
                        if (opts.protocol === 'https:') {
                            const tlsSocket = tls.connect({
                                socket,
                                servername: opts.servername || opts.hostname,
                            });
                            tlsSocket.once('secureConnect', () => cb(null, tlsSocket));
                            tlsSocket.once('error', (err: Error) => cb(err));
                        } else {
                            cb(null, socket);
                        }
                    })
                    .catch((err: Error) => cb(err));
            },
        });
    }

    private _rebuildDispatcher(): void {
        if (!UndiciAgent) return; // deps not loaded yet (pre-install)
        if (this._dispatcher) void this._dispatcher.close().catch(() => {});
        const p = this.current;
        if (p) this._dispatcher = this._createDispatcher(p.host, p.port);
    }

    /**
     * Shuffle the pool, pick the first proxy, override globalThis.fetch
     * so all subsequent fetch() calls are routed through the SOCKS5 proxy.
     */
    async install(): Promise<void> {
        if (this._installed || !this.proxies.length) return;
        await ensureDeps();

        shuffle(this.proxies);
        this.currentIndex = 0;
        this._rebuildDispatcher();

        this._originalFetch = globalThis.fetch;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const pool = this;

        globalThis.fetch = function proxyFetch(url: any, opts: any = {}): Promise<Response> {
            if (pool._dispatcher) {
                return pool._originalFetch!.call(globalThis, url, {
                    ...opts,
                    dispatcher: pool._dispatcher,
                });
            }
            return pool._originalFetch!.call(globalThis, url, opts);
        } as typeof fetch;

        this._installed = true;
        const p = this.current!;
        log.info(`SOCKS5 proxy: ${p.host}:${p.port} (pool: ${this.proxies.length})`);
    }
}

/** Singleton shared across the CLI. */
export const proxyPool = new ProxyPool();

/**
 * Fetch the Mullvad WireGuard relay list and populate `proxyPool` with
 * SOCKS5 endpoints derived from each active relay's hostname.
 *
 * Relay hostname format:  `se-mma-wg-001`
 * SOCKS5 hostname format: `se-mma-wg-socks5-001.relays.mullvad.net:1080`
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

        const m = (relay.hostname as string).match(/^(.+)-wg-(\d+)$/);
        if (!m) continue;

        const socksHost = `${m[1]}-wg-socks5-${m[2]}.relays.mullvad.net`;
        proxyPool.add(socksHost, 1080);
        count++;
    }

    log.success(`${count} Mullvad SOCKS5 relays loaded`);
    if (count === 0) throw new Error('No active Mullvad WireGuard relays found');
}
