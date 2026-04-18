/**
 * Stub browser-only globals referenced by modules we share with the web app.
 *
 * `js/ModernSettings.ts` and `js/storage.js` both touch `localStorage` during
 * their top-level property registration; `js/icons.ts` transitively pulls in
 * SVG virtual modules via Vite. Installing a no-op `localStorage` before any
 * `#js/*` import keeps CLI startup silent without requiring edits to the
 * shared web modules.
 */

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
    key(index: number): string | null;
    readonly length: number;
}

const g = globalThis as unknown as { localStorage?: StorageLike; sessionStorage?: StorageLike };

if (typeof g.localStorage === 'undefined') {
    const store = new Map<string, string>();
    g.localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
            return store.size;
        },
    };
}

if (typeof g.sessionStorage === 'undefined') {
    g.sessionStorage = g.localStorage;
}
