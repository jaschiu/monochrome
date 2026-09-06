/**
 * Hardcoded fallback list of Monochrome API + streaming instances.
 *
 * Used by:
 *  - `js/storage.js` — as the fallback when the upstream uptime-worker
 *    JSON can't be reached (versions are consumed by the settings UI's
 *    minVersion filter).
 *  - `cli/src/instances.ts` — projected to bare URL strings when the CLI's
 *    `apiSettings.getInstances()` lookup returns nothing.
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
    api: [{ url: 'https://lol.samidy.workers.dev', version: '2.10' }],
    streaming: [],
};

/** Project the typed fallback into bare URL strings (used by the CLI). */
export function defaultInstanceUrls(): { api: string[]; streaming: string[] } {
    return {
        api: DEFAULT_INSTANCES.api.map((i) => i.url),
        streaming: DEFAULT_INSTANCES.streaming.map((i) => i.url),
    };
}
