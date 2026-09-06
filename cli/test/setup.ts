/**
 * Browser globals required by shared web modules that the CLI tests import.
 *
 * Vitest runs setup files before evaluating test modules, so this runs before
 * any `#js/*` import resolves.
 */

const g = globalThis as unknown as {
    localStorage?: Storage;
    sessionStorage?: Storage;
    navigator?: Navigator;
};

function makeStorage(): Storage {
    const store = new Map<string, string>();
    return {
        getItem(key: string) {
            return store.has(key) ? store.get(key)! : null;
        },
        setItem(key: string, value: string) {
            store.set(key, String(value));
        },
        removeItem(key: string) {
            store.delete(key);
        },
        clear() {
            store.clear();
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null;
        },
        get length() {
            return store.size;
        },
    } as Storage;
}

if (typeof g.localStorage === 'undefined') {
    g.localStorage = makeStorage();
}
if (typeof g.sessionStorage === 'undefined') {
    g.sessionStorage = g.localStorage;
}
if (typeof g.navigator === 'undefined') {
    Object.defineProperty(g, 'navigator', {
        value: {
            userAgent: 'Monochrome-CLI-Test',
            maxTouchPoints: 0,
        },
        configurable: true,
    });
}
