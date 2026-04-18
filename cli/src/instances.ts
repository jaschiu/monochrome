import { defaultInstanceUrls } from '#js/default-instances.ts';

const DEFAULT_INSTANCES_URL =
    'https://raw.githubusercontent.com/monochrome-music/monochrome/refs/heads/main/public/instances.json';

// Shared fallback list lives in `js/default-instances.ts` (also consumed by
// `js/storage.js`). Project to bare URLs here since the CLI has no use for
// per-instance version metadata.
const { api: HARDCODED_API_INSTANCES, streaming: HARDCODED_STREAMING_INSTANCES } = defaultInstanceUrls();

export interface Instances {
    api: string[];
    streaming: string[];
}

interface UpstreamInstances {
    api?: string[];
    streaming?: string[];
}

/**
 * Fetches instances from the upstream JSON, falling back to hardcoded list.
 */
async function fetchUpstreamInstances(): Promise<UpstreamInstances | null> {
    try {
        const res = await fetch(DEFAULT_INSTANCES_URL, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as UpstreamInstances;
    } catch {
        return null;
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
        const upstream = await fetchUpstreamInstances();
        if (upstream) {
            apiInstances = upstream.api || [];
            streamingInstances = upstream.streaming || [];
        } else {
            apiInstances = [...HARDCODED_API_INSTANCES];
            streamingInstances = [...HARDCODED_STREAMING_INSTANCES];
        }
    }

    // Prepend custom instances to both lists
    if (customInstances.length > 0) {
        apiInstances = [...customInstances, ...apiInstances];
        streamingInstances = [...customInstances, ...streamingInstances];
    }

    // Deduplicate while preserving order
    apiInstances = [...new Set(apiInstances)];
    streamingInstances = [...new Set(streamingInstances)];

    return { api: apiInstances, streaming: streamingInstances };
}
