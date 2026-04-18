let verboseEnabled = false;
let progressActive = false;

function clearProgress() {
    if (progressActive) {
        process.stderr.write('\r\x1b[K');
        progressActive = false;
    }
}

export const log = {
    setVerbose(enabled: boolean) {
        verboseEnabled = enabled;
    },

    info(...args: unknown[]) {
        clearProgress();
        console.error(...args);
    },

    warn(...args: unknown[]) {
        clearProgress();
        console.error('\x1b[33m⚠\x1b[0m', ...args);
    },

    error(...args: unknown[]) {
        clearProgress();
        console.error('\x1b[31m✖\x1b[0m', ...args);
    },

    success(...args: unknown[]) {
        clearProgress();
        console.error('\x1b[32m✔\x1b[0m', ...args);
    },

    verbose(...args: unknown[]) {
        if (verboseEnabled) {
            clearProgress();
            console.error('\x1b[90m', ...args, '\x1b[0m');
        }
    },

    progress(current: number, total: number, label = '') {
        const width = 30;
        const pct = total > 0 ? current / total : 0;
        const filled = Math.round(width * pct);
        const bar = '\x1b[36m' + '█'.repeat(filled) + '\x1b[90m' + '░'.repeat(width - filled) + '\x1b[0m';
        const pctStr = (pct * 100).toFixed(1).padStart(5) + '%';
        process.stderr.write(`\r  ${bar} ${pctStr} ${label}\x1b[K`);
        progressActive = true;
    },

    progressEnd() {
        clearProgress();
    },

    /**
     * Dynamic single-line meter for DASH/ffmpeg time-based progress.
     * @param timeStr - current position, e.g. "00:01:23.45"
     * @param durationSec - total duration in seconds (if known)
     */
    dashProgress(timeStr: string, durationSec: number | null = null) {
        let line: string;
        if (durationSec && durationSec > 0) {
            const parts = timeStr.split(':').map(Number);
            const currentSec = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
            const pct = Math.min(currentSec / durationSec, 1);
            const width = 30;
            const filled = Math.round(width * pct);
            const bar = '\x1b[36m' + '█'.repeat(filled) + '\x1b[90m' + '░'.repeat(width - filled) + '\x1b[0m';
            const pctStr = (pct * 100).toFixed(0).padStart(3) + '%';
            line = `\r  ${bar} ${pctStr}  ${timeStr}\x1b[K`;
        } else {
            line = `\r  \x1b[36m⟳\x1b[0m  ${timeStr}\x1b[K`;
        }
        process.stderr.write(line);
        progressActive = true;
    },
};
