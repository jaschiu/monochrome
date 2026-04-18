/**
 * Pure, DOM-free lyrics helpers shared between web and CLI.
 *
 * Kept in its own file so the CLI bundle doesn't pull in `LyricsManager`
 * (which depends on the DOM, kuroshiro script loader, etc.).
 */

/**
 * Unicode ranges covering CJK/Korean scripts plus CJK punctuation and
 * halfwidth/fullwidth forms. Superset of both the previous web and CLI
 * regexes so either caller gets the same behaviour.
 *
 * - `\u3000-\u303F` CJK Symbols and Punctuation
 * - `\u3040-\u309F` Hiragana
 * - `\u30A0-\u30FF` Katakana
 * - `\u3130-\u318F` Hangul Compatibility Jamo
 * - `\u3400-\u4DBF` CJK Unified Ideographs Extension A
 * - `\u4E00-\u9FFF` CJK Unified Ideographs
 * - `\uAC00-\uD7AF` Hangul Syllables
 * - `\u1100-\u11FF` Hangul Jamo
 * - `\uFF00-\uFFEF` Halfwidth and Fullwidth Forms
 */
const ASIAN_TEXT_REGEX =
    /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u1100-\u11FF\uFF00-\uFFEF]/;

/** True if `text` contains any CJK/Korean character (or CJK punctuation/fullwidth form). */
export function containsAsianText(text: string | null | undefined): boolean {
    if (!text) return false;
    return ASIAN_TEXT_REGEX.test(text);
}
