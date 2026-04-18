import { log } from './log.js';
import { containsAsianText } from '#js/lyrics-utils.ts';
import type { ApiClient } from './api.js';
import type { Instances } from './instances.js';

export interface LyricsData {
    synced: string | null;
    plain: string | null;
}

/**
 * Fetch lyrics for a track from the API.
 */
export async function fetchLyrics(
    _apiClient: ApiClient,
    instances: Instances,
    trackId: string | number
): Promise<LyricsData> {
    try {
        const { fetchWithRetry } = await import('./api.js');
        const response = await fetchWithRetry(instances, `/lyrics/?id=${trackId}`, { type: 'api' });
        const data = (await response.json()) as any;
        const unwrapped = data.data || data;

        return {
            synced: unwrapped.subtitles || null,
            plain: unwrapped.lyrics || null,
        };
    } catch (err) {
        log.verbose(`  No lyrics found for track ${trackId}: ${(err as Error).message}`);
        return { synced: null, plain: null };
    }
}

/**
 * Convert synced lyrics (subtitles) to LRC format.
 */
export function toLRC(
    synced: string | null,
    metadata: { title?: string; artist?: string; album?: string } = {}
): string | null {
    if (!synced) return null;

    let lrc = '';

    if (metadata.title) lrc += `[ti:${metadata.title}]\n`;
    if (metadata.artist) lrc += `[ar:${metadata.artist}]\n`;
    if (metadata.album) lrc += `[al:${metadata.album}]\n`;
    lrc += `[by:monochrome-dl]\n\n`;

    let lines: any;
    try {
        lines = JSON.parse(synced);
    } catch {
        lrc += synced;
        return lrc;
    }

    if (Array.isArray(lines)) {
        for (const line of lines) {
            const startMs = line.startTimeMs || line.start || 0;
            const text = line.text || line.words || '';

            const totalSec = Math.floor(startMs / 1000);
            const min = Math.floor(totalSec / 60);
            const sec = totalSec % 60;
            const cs = Math.floor((startMs % 1000) / 10);

            lrc += `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}]${text}\n`;
        }
    }

    return lrc;
}

/**
 * Convert Japanese/CJK lyrics to Romaji using kuroshiro.
 * Requires kuroshiro and kuroshiro-analyzer-kuromoji to be installed.
 */
let kuroshiroInstance: any = null;

async function getKuroshiro(): Promise<any> {
    if (kuroshiroInstance) return kuroshiroInstance;

    try {
        const Kuroshiro = (await import('kuroshiro' as string)).default;
        const KuromojiAnalyzer = (await import('kuroshiro-analyzer-kuromoji' as string)).default;

        kuroshiroInstance = new Kuroshiro();
        await kuroshiroInstance.init(new KuromojiAnalyzer());
        return kuroshiroInstance;
    } catch {
        log.warn('Romaji conversion requires kuroshiro and kuroshiro-analyzer-kuromoji packages.');
        log.warn('Install with: npm install kuroshiro kuroshiro-analyzer-kuromoji');
        return null;
    }
}

/**
 * Convert lyrics text to Romaji if it contains Japanese characters.
 */
export async function convertToRomaji(text: string): Promise<string> {
    if (!text || !containsAsianText(text)) return text;

    const kuroshiro = await getKuroshiro();
    if (!kuroshiro) return text;

    try {
        return await kuroshiro.convert(text, {
            to: 'romaji',
            mode: 'spaced',
            romajiSystem: 'hepburn',
        });
    } catch (err) {
        log.verbose(`  Romaji conversion failed: ${(err as Error).message}`);
        return text;
    }
}

/**
 * Convert an entire LRC string to Romaji.
 */
export async function convertLRCToRomaji(lrcContent: string): Promise<string> {
    if (!lrcContent) return lrcContent;

    const lines = lrcContent.split('\n');
    const converted: string[] = [];

    for (const line of lines) {
        const match = line.match(/^(\[[^\]]+\])(.*)$/);
        if (match) {
            const timestamp = match[1];
            const text = match[2];
            const romajiText = await convertToRomaji(text);
            converted.push(`${timestamp}${romajiText}`);
        } else {
            converted.push(line);
        }
    }

    return converted.join('\n');
}
