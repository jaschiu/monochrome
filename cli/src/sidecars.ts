/**
 * Sidecar file generators — thin re-export from the shared playlist-generator module.
 */
// @ts-expect-error - JS module without types
export { generateM3U, generateM3U8, generateCUE, generateNFO, generateJSON } from '#js/playlist-generator.js';
