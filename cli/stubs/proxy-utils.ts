/**
 * Node identity stub for `js/proxy-utils.js`.
 *
 * The web app routes some Tidal audio URLs through a CORS/anti-bot worker, but
 * the CLI downloads directly from api.tidal.com and the CDN. Keep every URL
 * untouched.
 */
export function getProxyUrl(url: string): string {
    return url;
}

export function isTidalAudioUrl(_url: string | URL): boolean {
    return false;
}

export function wrapTidalUrl(url: string): string {
    return url;
}
