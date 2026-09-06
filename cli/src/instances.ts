import { defaultInstanceUrls } from '#js/default-instances.ts';
// @ts-expect-error - JS module without full types
import { apiSettings } from '#js/storage.js';
import { log } from './log.js';

// Shared fallback list lives in `js/default-instances.ts` (also consumed by
// `js/storage.js`). Project to bare URLs here since the CLI has no use for
// per-instance version metadata.
const {
    api: HARDCODED_API_INSTANCES,
    streaming: HARDCODED_STREAMING_INSTANCES,
} = defaultInstanceUrls();

export interface Instances {
    api: string[];
    streaming: string[];
}

type InstanceEntry = string | { url?: string };

function toUrls(entries: InstanceEntry[]): string[] {
    return entries
        .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
        .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

/**
 * Load instances through the web app's own loader (`js/storage.js`).
 *
 * `apiSettings` owns the uptime-worker endpoints and the `.squid.wtf` blocklist,
 * so going through it keeps the CLI on exactly the instance set the website uses.
 * The in-memory `localStorage` stub means its cache is per-process only.
 */
async function loadSharedInstances(): Promise<Instances | null> {
    // `apiSettings` reports uptime-worker failures with console.warn/error,
    // which the web app shows in devtools. Demote them to verbose CLI logging
    // so a fallback to the hardcoded list isn't alarming noise.
    const { warn, error } = console;
    console.warn = console.error = (...args: unknown[]) => log.verbose(`  ${args.map(String).join(' ')}`);

    try {
        const [api, streaming] = (await Promise.all([
            apiSettings.getInstances('api'),
            apiSettings.getInstances('streaming'),
        ])) as InstanceEntry[][];

        const resolved = { api: toUrls(api), streaming: toUrls(streaming) };
        return resolved.api.length > 0 ? resolved : null;
    } catch (err) {
        log.verbose(`  Instance lookup failed: ${(err as Error).message}`);
        return null;
    } finally {
        console.warn = warn;
        console.error = error;
    }
}

/**
 * Resolves the list of API and streaming instances to use.
 */
export async function resolveInstances({
    customInstances = [],
    noDefaults = false,
}: {
    customInstances?: string[];
    noDefaults?: boolean;
} = {}): Promise<Instances> {
    let apiInstances: string[] = [];
    let streamingInstances: string[] = [];

    if (!noDefaults) {
        const shared = await loadSharedInstances();
        if (shared) {
            apiInstances = shared.api;
            streamingInstances = shared.streaming.length ? shared.streaming : [...shared.api];
        } else {
            apiInstances = [...HARDCODED_API_INSTANCES];
            streamingInstances = [...HARDCODED_STREAMING_INSTANCES];
        }
    }

    // Prepend custom instances.
    if (customInstances.length > 0) {
        apiInstances = [...customInstances, ...apiInstances];
        streamingInstances = [...customInstances, ...streamingInstances];
    }

    // Deduplicate while preserving order
    apiInstances = [...new Set(apiInstances)];
    streamingInstances = [...new Set(streamingInstances)];

    return { api: apiInstances, streaming: streamingInstances };
}
