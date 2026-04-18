import { execFile } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { log } from './log.js';
import {
    customFormats as CUSTOM_FORMATS,
    containerFormats as CONTAINER_FORMATS,
    isCustomFormat,
    getCustomFormat,
} from '#js/ffmpegFormats.ts';
// @ts-expect-error - JS module without full types
import {
    detectAudioFormat,
    getExtensionForQuality as _getExtensionForQuality,
} from '#js/utils.js';

export { isCustomFormat };

export function getFormatExtension(quality: string): string | null {
    const fmt = getCustomFormat(quality);
    return fmt ? fmt.extension : null;
}

/**
 * Check if ffmpeg is available on the system.
 */
export async function checkFfmpeg(): Promise<boolean> {
    return new Promise((resolve) => {
        execFile('ffmpeg', ['-version'], (err) => {
            resolve(!err);
        });
    });
}

function tmpFile(ext: string): string {
    return join(tmpdir(), `monochrome-${randomBytes(8).toString('hex')}.${ext}`);
}

/**
 * Run ffmpeg with given args on input buffer, return output buffer.
 */
export async function runFfmpeg(
    inputBuffer: Buffer,
    inputExt: string,
    outputExt: string,
    extraArgs: string[] = []
): Promise<Buffer> {
    const inPath = tmpFile(inputExt);
    const outPath = tmpFile(outputExt);

    try {
        await writeFile(inPath, inputBuffer);

        const args = ['-y', '-i', inPath, ...extraArgs, '-map_metadata', '-1', outPath];
        log.verbose(`  ffmpeg ${args.join(' ')}`);

        await new Promise<void>((resolve, reject) => {
            execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
                if (err) {
                    log.verbose(`  ffmpeg stderr: ${stderr}`);
                    reject(new Error(`ffmpeg failed: ${err.message}`));
                } else {
                    resolve();
                }
            });
        });

        return await readFile(outPath);
    } finally {
        await unlink(inPath).catch(() => {});
        await unlink(outPath).catch(() => {});
    }
}

/**
 * Detect audio format from file header bytes.
 * Wraps `detectAudioFormat` (which takes a DataView) for CLI Buffer input.
 */
export function detectFormat(buffer: Buffer): string | null {
    const view = new DataView(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, 64));
    return detectAudioFormat(view);
}

/**
 * Get file extension for a given quality string.
 */
export function getExtensionForQuality(quality: string): string {
    const fmt = getCustomFormat(quality);
    if (fmt) return fmt.extension;
    return _getExtensionForQuality(quality);
}

/**
 * Apply transcoding/container conversion to audio buffer.
 */
export async function applyPostProcessing(
    buffer: Buffer,
    quality: string,
    container: string = 'nochange',
    trackAudioQuality: string | null = null
): Promise<{ buffer: Buffer; extension: string }> {
    // Reference the re-exported symbol so unused-import rules stay happy.
    void CUSTOM_FORMATS;

    const format = detectFormat(buffer);
    const inputExt = format || 'flac';

    const statedLossless = (trackAudioQuality || quality).endsWith('LOSSLESS');
    const sourceIsLossless = format === 'flac' || (format === 'm4a' && statedLossless);

    // Custom lossy format
    if (isCustomFormat(quality)) {
        if (!sourceIsLossless) {
            log.verbose('  Source is already lossy, skipping transcode to avoid quality degradation');
            return { buffer, extension: inputExt };
        }
        const fmt = getCustomFormat(quality)!;
        log.info(`  Transcoding to ${quality}...`);
        const result = await runFfmpeg(buffer, inputExt, fmt.extension, fmt.ffmpegArgs);
        return { buffer: result, extension: fmt.extension };
    }

    // Lossless container conversion
    if (statedLossless && container !== 'nochange' && container in CONTAINER_FORMATS) {
        if (!sourceIsLossless) {
            log.warn('Source is not lossless, skipping container conversion');
            return { buffer, extension: inputExt };
        }

        const containerFmt = CONTAINER_FORMATS[container];
        if (container === 'flac' && format === 'flac') {
            log.info('  Rebuilding FLAC (stripping metadata)...');
            const result = await runFfmpeg(buffer, 'flac', 'flac', ['-c:a', 'copy']);
            return { buffer: result, extension: 'flac' };
        }

        log.info(`  Converting to ${container}...`);
        const result = await runFfmpeg(buffer, inputExt, containerFmt.extension, containerFmt.ffmpegArgs);
        return { buffer: result, extension: containerFmt.extension };
    }

    return { buffer, extension: inputExt };
}
