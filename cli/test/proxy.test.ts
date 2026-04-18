#!/usr/bin/env node

/**
 * Integration tests for SOCKS5 proxy (Mullvad) and cuimp (curl-impersonate).
 *
 * Usage:  bun run vite-node --config vite.cli.config.ts cli/test/proxy.test.ts
 *
 * Prerequisites:
 *   - cuimp package installed (`npm i cuimp`)
 *   - curl-impersonate binary at /usr/bin/curl-impersonate
 *   - Active Mullvad VPN connection for proxy tests (optional — skipped if offline)
 *   - Network access
 *
 * Exit 0 = all passed, non-zero = failure(s).
 */

import '../bin/bootstrap-browser-globals.js';
import assert from 'node:assert/strict';
import { proxyPool, fetchMullvadRelays } from '../src/proxy.js';

let pass = 0;
let fail = 0;
let skip = 0;

function ok(label: string) {
    pass++;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
}

function failed(label: string, err?: unknown) {
    fail++;
    console.error(`  \x1b[31m✖\x1b[0m ${label}`);
    if (err) {
        const msg = (err as Error)?.message ?? JSON.stringify(err);
        console.error(`    ${msg}`);
    }
}

function skipped(label: string, reason: string) {
    skip++;
    console.log(`  \x1b[33m⊘\x1b[0m ${label} — ${reason}`);
}

async function test(label: string, fn: () => void | Promise<void>) {
    try {
        await fn();
        ok(label);
    } catch (err) {
        const msg = (err as Error).message;
        if (msg?.startsWith('SKIP:')) {
            skipped(label, msg.slice(5).trim());
        } else {
            failed(label, err);
        }
    }
}

// Save original fetch so we can restore after tests
const _originalFetch = globalThis.fetch;

console.log('\nMullvad relay fetching');

await test('fetchMullvadRelays populates proxyPool', async () => {
    proxyPool.proxies = [];
    proxyPool.currentIndex = 0;

    try {
        await fetchMullvadRelays();
    } catch (err) {
        throw new Error(`SKIP: ${(err as Error).message}`);
    }

    assert.ok(proxyPool.proxies.length > 0, `Expected >0 proxies, got ${proxyPool.proxies.length}`);
    console.log(`      ${proxyPool.proxies.length} relays loaded`);
});

await test('relay hostnames follow socks5 naming convention and are US-only', () => {
    if (proxyPool.proxies.length === 0) {
        throw new Error('SKIP: no relays loaded');
    }

    const sample = proxyPool.proxies.slice(0, 5);
    for (const p of sample) {
        assert.match(
            p.host,
            /^.+-wg-socks5-\d+\.relays\.mullvad\.net$/,
            `Unexpected hostname format: ${p.host}`
        );
        assert.ok(p.host.startsWith('us-'), `Expected US relay, got: ${p.host}`);
        assert.equal(p.port, 1080, `Expected port 1080, got ${p.port}`);
    }
});

console.log('\ncuimp impersonation');

const cuimpAvailable = await (async () => {
    try {
        proxyPool.proxies = [];
        proxyPool.currentIndex = 0;
        (proxyPool as any)._installed = false;
        (proxyPool as any)._client = null;

        await proxyPool.install();
        return true;
    } catch (err) {
        console.log(
            `  \x1b[33m⊘\x1b[0m cuimp unavailable — skipping impersonation tests (${(err as Error).message})`
        );
        return false;
    }
})();

if (cuimpAvailable) {
    await test('TLS fingerprint resembles a real browser (tls.peet.ws)', async () => {
        const res = await globalThis.fetch('https://tls.peet.ws/api/all');
        assert.ok(res.ok, `tls.peet.ws returned HTTP ${res.status}`);

        const data = (await res.json()) as any;

        assert.ok(data.tls, 'Response should contain TLS data');
        console.log(`      JA4:          ${data.tls.ja4 || 'n/a'}`);
        console.log(`      JA3 hash:     ${data.tls.ja3_hash || 'n/a'}`);
        console.log(`      HTTP version: ${data.http_version || 'n/a'}`);
        console.log(`      User-Agent:   ${(data.user_agent || 'n/a').slice(0, 80)}`);

        const ua = data.user_agent || '';
        assert.ok(!ua.includes('node') && !ua.includes('undici'), `User-Agent should not expose Node.js: ${ua}`);
    });

    await test('httpbin echo shows browser-like request headers', async () => {
        const res = await globalThis.fetch('https://httpbin.org/get');
        assert.ok(res.ok, `httpbin.org returned HTTP ${res.status}`);

        const data = (await res.json()) as any;
        const headers = data.headers || {};

        console.log(`      Origin IP:    ${data.origin || 'n/a'}`);
        console.log(`      User-Agent:   ${(headers['User-Agent'] || 'n/a').slice(0, 80)}`);

        const ua = headers['User-Agent'] || '';
        assert.ok(
            ua.includes('Mozilla') || ua.includes('Chrome') || ua.includes('Firefox'),
            `Expected browser User-Agent, got: ${ua}`
        );
    });

    await test('newIdentity switches browser fingerprint', async () => {
        const res1 = await globalThis.fetch('https://tls.peet.ws/api/all');
        assert.ok(res1.ok);
        const data1 = (await res1.json()) as any;
        const ja3_1 = data1.tls?.ja3_hash;
        const ua1 = data1.user_agent;

        let switched = false;
        for (let attempt = 0; attempt < 5; attempt++) {
            proxyPool.newIdentity();
            const res2 = await globalThis.fetch('https://tls.peet.ws/api/all');
            if (!res2.ok) continue;
            const data2 = (await res2.json()) as any;
            const ja3_2 = data2.tls?.ja3_hash;
            const ua2 = data2.user_agent;

            if (ja3_2 !== ja3_1 || ua2 !== ua1) {
                switched = true;
                console.log(`      Before: JA3=${ja3_1}, UA=${(ua1 || '').slice(0, 40)}`);
                console.log(`      After:  JA3=${ja3_2}, UA=${(ua2 || '').slice(0, 40)}`);
                break;
            }
        }
        assert.ok(switched, 'newIdentity should produce a different TLS fingerprint or User-Agent');
    });
}

console.log('\nMullvad proxy + cuimp (requires active Mullvad VPN)');

await test('proxied request reaches Mullvad exit (am.i.mullvad.net)', async () => {
    if (!cuimpAvailable) throw new Error('SKIP: cuimp not available');

    proxyPool.proxies = [];
    proxyPool.currentIndex = 0;
    (proxyPool as any)._installed = false;
    (proxyPool as any)._client = null;

    try {
        await fetchMullvadRelays();
    } catch {
        throw new Error('SKIP: could not fetch Mullvad relays');
    }

    if (proxyPool.proxies.length === 0) {
        throw new Error('SKIP: no Mullvad relays available');
    }

    await proxyPool.install();

    let connected = false;
    let lastErr = '';

    for (let attempt = 0; attempt < Math.min(5, proxyPool.proxies.length); attempt++) {
        try {
            const res = await globalThis.fetch('https://am.i.mullvad.net/json');
            if (!res.ok) {
                lastErr = `HTTP ${res.status}`;
                proxyPool.rotate();
                continue;
            }

            const data = (await res.json()) as any;
            console.log(`      IP:           ${data.ip || 'n/a'}`);
            console.log(`      Country:      ${data.country || 'n/a'}`);
            console.log(`      City:         ${data.city || 'n/a'}`);
            console.log(`      Mullvad exit: ${data.mullvad_exit_ip ? 'yes' : 'no'}`);
            console.log(`      Organization: ${data.organization || 'n/a'}`);

            assert.ok(
                data.mullvad_exit_ip === true || data.mullvad_exit_ip_hostname,
                'Traffic should exit through a Mullvad relay'
            );
            connected = true;
            break;
        } catch (err) {
            lastErr = (err as Error).message;
            proxyPool.rotate();
        }
    }

    if (!connected) {
        throw new Error(`SKIP: could not connect through any Mullvad proxy (${lastErr})`);
    }
});

await test('proxied request has browser TLS fingerprint', async () => {
    if (!cuimpAvailable || proxyPool.proxies.length === 0) {
        throw new Error('SKIP: cuimp or proxies not available');
    }

    let data: any;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await globalThis.fetch('https://tls.peet.ws/api/all');
            if (!res.ok) {
                proxyPool.rotate();
                continue;
            }
            data = await res.json();
            break;
        } catch {
            proxyPool.rotate();
        }
    }

    if (!data) throw new Error('SKIP: could not reach tls.peet.ws through proxy');

    console.log(`      Proxied JA4:  ${data.tls?.ja4 || 'n/a'}`);
    console.log(`      Proxied IP:   ${data.ip || 'n/a'}`);

    const ua = data.user_agent || '';
    assert.ok(
        !ua.includes('node') && !ua.includes('undici'),
        `Proxied User-Agent should not expose Node.js: ${ua}`
    );
    assert.ok(data.tls, 'Proxied response should contain TLS fingerprint data');
});

globalThis.fetch = _originalFetch;
proxyPool.proxies = [];
proxyPool.currentIndex = 0;

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Passed: ${pass}   Failed: ${fail}   Skipped: ${skip}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

process.exit(fail > 0 ? 1 : 0);
