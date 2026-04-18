/**
 * Hardcoded fallback list of Monochrome API + streaming instances.
 *
 * Used by:
 *  - `js/storage.js` — as the fallback when the upstream uptime-worker
 *    JSON can't be reached (versions are consumed by the settings UI's
 *    minVersion filter).
 *  - `cli/src/instances.ts` — projected to bare URL strings when the
 *    upstream `public/instances.json` fetch fails.
 *
 * Keep this list as the single source of truth; web-only filters (e.g.
 * `.squid.wtf` blocklist in `js/storage.js`) still apply on top.
 */

export interface DefaultInstance {
    url: string;
    version: string;
}

export interface DefaultInstances {
    api: DefaultInstance[];
    streaming: DefaultInstance[];
}

export const DEFAULT_INSTANCES: DefaultInstances = {
    api: [
        { url: 'https://hifi.geeked.wtf', version: '2.7' },
        { url: 'https://eu-central.monochrome.tf', version: '2.7' },
        { url: 'https://us-west.monochrome.tf', version: '2.7' },
        { url: 'https://api.monochrome.tf', version: '2.5' },
        { url: 'https://monochrome-api.samidy.com', version: '2.3' },
        { url: 'https://maus.qqdl.site', version: '2.6' },
        { url: 'https://vogel.qqdl.site', version: '2.6' },
        { url: 'https://katze.qqdl.site', version: '2.6' },
        { url: 'https://hund.qqdl.site', version: '2.6' },
        { url: 'https://tidal.kinoplus.online', version: '2.2' },
        { url: 'https://wolf.qqdl.site', version: '2.2' },
    ],
    streaming: [
        { url: 'https://hifi.geeked.wtf', version: '2.7' },
        { url: 'https://maus.qqdl.site', version: '2.6' },
        { url: 'https://vogel.qqdl.site', version: '2.6' },
        { url: 'https://katze.qqdl.site', version: '2.6' },
        { url: 'https://hund.qqdl.site', version: '2.6' },
        { url: 'https://wolf.qqdl.site', version: '2.6' },
    ],
};

/** Project the typed fallback into bare URL strings (used by the CLI). */
export function defaultInstanceUrls(): { api: string[]; streaming: string[] } {
    return {
        api: DEFAULT_INSTANCES.api.map((i) => i.url),
        streaming: DEFAULT_INSTANCES.streaming.map((i) => i.url),
    };
}
