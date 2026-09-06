import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR = join(homedir(), '.cache', 'monochrome');

function cacheKey(namespace: string, id: string | number | object): string {
    const raw = `${namespace}:${typeof id === 'object' ? JSON.stringify(id) : String(id)}`;
    return createHash('sha256').update(raw).digest('hex');
}

function cachePath(namespace: string, id: string | number | object): string {
    return join(CACHE_DIR, namespace, cacheKey(namespace, id) + '.json');
}

export async function ensureCacheDir(namespace: string): Promise<void> {
    await mkdir(join(CACHE_DIR, namespace), { recursive: true });
}

export async function cacheGet<T = unknown>(namespace: string, id: string | number | object): Promise<T | null> {
    try {
        const data = await readFile(cachePath(namespace, id), 'utf-8');
        return JSON.parse(data) as T;
    } catch {
        return null;
    }
}

export async function cacheSet(namespace: string, id: string | number | object, value: unknown): Promise<void> {
    await ensureCacheDir(namespace);
    await writeFile(cachePath(namespace, id), JSON.stringify(value), 'utf-8');
}

export async function cacheClear(): Promise<void> {
    try {
        await rm(CACHE_DIR, { recursive: true, force: true });
    } catch {
        // ignore
    }
}

export async function cacheStats(): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    try {
        const namespaces = await readdir(CACHE_DIR);
        for (const ns of namespaces) {
            const nsPath = join(CACHE_DIR, ns);
            const nsStat = await stat(nsPath);
            if (!nsStat.isDirectory()) continue;
            const entries = await readdir(nsPath);
            for (const entry of entries) {
                const fileStat = await stat(join(nsPath, entry));
                files++;
                bytes += fileStat.size;
            }
        }
    } catch {
        // empty cache
    }
    return { files, bytes };
}
