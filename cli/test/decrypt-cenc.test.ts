import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptCencMp4 } from '../src/transcode.js';

function run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
        });
    });
}

describe('decryptCencMp4', () => {
    it('round-trips an ffmpeg-encrypted FLAC-in-MP4', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'mono-cenc-'));
        const source = join(dir, 'sine.flac');
        const encrypted = join(dir, 'sine-cenc.mp4');

        const key = '00112233445566778899aabbccddeeff';
        const kid = 'aabbccddeeff00112233445566778899';

        await run('ffmpeg', [
            '-y',
            '-f', 'lavfi',
            '-i', 'sine=frequency=1000:duration=1',
            '-c:a', 'flac',
            source,
        ]);
        await run('ffmpeg', [
            '-y',
            '-i', source,
            '-c', 'copy',
            '-encryption_scheme', 'cenc-aes-ctr',
            '-encryption_key', key,
            '-encryption_kid', kid,
            '-f', 'mp4',
            encrypted,
        ]);

        const encryptedBuffer = await readFile(encrypted);
        const decrypted = await decryptCencMp4(encryptedBuffer, key, { keyId: kid, outputFormat: 'flac' });

        // Ensure the output is a valid FLAC by checking the magic bytes.
        expect(decrypted.slice(0, 4).toString('utf-8')).toBe('fLaC');
        expect(decrypted.length).toBeGreaterThan(100);
    }, 30000);
});
