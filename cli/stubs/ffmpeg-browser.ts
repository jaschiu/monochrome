/**
 * Node-safe stub for the browser-only `js/ffmpeg.ts` module.
 *
 * The CLI uses the system `ffmpeg` binary via `child_process` and never
 * executes the wasm-based browser transcoder, but it transitively imports
 * `js/ffmpegFormats.ts` → `js/ffmpeg` to reach the format definitions.
 * Replacing `js/ffmpeg` with this stub keeps the CLI free of wasm and
 * the `@ffmpeg/*` packages at runtime.
 */
export async function ffmpeg(): Promise<Blob> {
    throw new Error('ffmpeg.wasm is not available in the CLI; use the system ffmpeg binary instead.');
}

export default ffmpeg;
