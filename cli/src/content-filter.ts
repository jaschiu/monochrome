/**
 * CLI side of the web app's non-negotiable content blocks.
 *
 * The website omits these items entirely rather than dimming them:
 *  - `contentBlockingSettings.HARDCODED_BLOCKED_ARTIST_IDS` (`js/storage.js`)
 *    survives localStorage clears and is checked by every renderer via
 *    `isHardcodedBlockedTrack` / `isHardcodedBlockedAlbum`.
 *  - `isBlockedCopyright` (`js/content-filter.ts`) drops rightsholders that
 *    filed notices; `js/ui.js` renders "unavailable due to a DMCA notice".
 *
 * Both lists are imported rather than copied so the CLI stays in step with
 * upstream whenever they change.
 */

// @ts-expect-error - JS module without full types
import { contentBlockingSettings } from '#js/storage.js';
import { isBlockedCopyright } from '#js/content-filter.ts';
import type { Album, AlbumSummary, Track } from './api.js';

export function isBlockedTrack(track: Track | null | undefined): boolean {
    if (!track) return false;
    if (contentBlockingSettings.isHardcodedBlockedTrack(track)) return true;
    if (isBlockedCopyright(track.copyright)) return true;
    return isBlockedAlbum(track.album);
}

export function isBlockedAlbum(album: Album | AlbumSummary | null | undefined): boolean {
    if (!album) return false;
    if (contentBlockingSettings.isHardcodedBlockedAlbum(album)) return true;
    return isBlockedCopyright(album.copyright);
}

/** Throws with the web app's wording when an item must not be served. */
export function assertNotBlocked(item: Track | Album | AlbumSummary | null | undefined, kind: 'track' | 'album'): void {
    const blocked = kind === 'track' ? isBlockedTrack(item as Track) : isBlockedAlbum(item as AlbumSummary);
    if (blocked) {
        throw new Error(`This ${kind} is unavailable due to a DMCA notice.`);
    }
}
