/**
 * Pure Tidal URL builders shared between web and CLI.
 *
 * Keep this module dependency-free so it stays cheap to import in either
 * environment. Callers layer on their own defaults (e.g. picsum fallback for
 * web thumbnails, `null` fallback for CLI cover downloads).
 */

/**
 * Build the `resources.tidal.com` cover-art URL for a Tidal image id.
 *
 * - `id` may be a bare image id (`"ab-cd-ef-..."`) — dashes are converted to
 *   slashes per Tidal's CDN scheme.
 * - Returns `null` if `id` is falsy or already an opaque URL/blob/asset path
 *   (those should be used directly by the caller).
 * - `size` is the square dimension in pixels (e.g. 320, 640, 1280).
 */
export function buildTidalCoverUrl(id: string | null | undefined, size: number | string = 1280): string | null {
    if (!id) return null;
    if (typeof id === 'string' && (id.startsWith('http') || id.startsWith('blob:') || id.startsWith('assets/'))) {
        return id;
    }

    const formattedId = String(id).replace(/-/g, '/');
    const dim = String(size);
    return `https://resources.tidal.com/images/${formattedId}/${dim}x${dim}.jpg`;
}
