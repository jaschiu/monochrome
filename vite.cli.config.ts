import { defineConfig, type Plugin } from 'vite';
import svgUse from './vite-plugin-svg-use.js';
import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Mark the bundled CLI entry executable so users can run
 * `./cli/dist/monochrome-dl.js` (and the shebang) directly after `npm run cli:build`.
 */
function chmodBinPlugin(entryFileName: string): Plugin {
    return {
        name: 'cli-chmod-bin',
        apply: 'build',
        async writeBundle(outputOptions) {
            const outDir = outputOptions.dir;
            if (!outDir) return;
            const full = path.resolve(outDir, entryFileName);
            await chmod(full, 0o755);
        },
    };
}

/**
 * Vite config for the Node.js CLI (`monochrome-dl`).
 *
 * Goals:
 *  - Resolve the web app's Vite-only virtual imports (e.g. `!lucide/...svg?svg&icon`
 *    used by `js/icons.ts`) so that CLI code can import from `#js/utils.js`
 *    and `#js/ffmpegFormats.ts` directly without any Node-friendly shim files.
 *  - Target Node (not the browser): no PWA, purgecss, auth-gate, upload, blob plugins,
 *    and no browser `stream` stub.
 *  - SSR build for distribution; `vite-node` reuses this config in development.
 */
export default defineConfig({
    // Suppress the "index.html not found" warning; this config is Node-only.
    appType: 'custom',
    resolve: {
        alias: [
            // Same virtual-module aliases as the web config so `js/icons.ts`
            // can resolve `!lucide/...svg?svg&icon` imports transitively.
            { find: '!lucide', replacement: path.resolve(__dirname, 'node_modules/lucide-static/icons') },
            { find: '!simpleicons', replacement: path.resolve(__dirname, 'node_modules/simple-icons/icons') },
            { find: '!', replacement: path.resolve(__dirname, 'node_modules') },
            // Stub browser-only ffmpeg.wasm entry — the CLI shells out to the
            // system `ffmpeg` binary and never uses `@ffmpeg/ffmpeg`.
            { find: /^(\.\/|#js\/)ffmpeg(\.ts|\.js)?$/, replacement: path.resolve(__dirname, 'cli/stubs/ffmpeg-browser.ts') },
            { find: /^@ffmpeg\/ffmpeg$/, replacement: path.resolve(__dirname, 'cli/stubs/ffmpeg-browser.ts') },
            { find: /^@ffmpeg\/core$/, replacement: path.resolve(__dirname, 'cli/stubs/ffmpeg-browser.ts') },
            { find: /^@ffmpeg\/util$/, replacement: path.resolve(__dirname, 'cli/stubs/ffmpeg-browser.ts') },
        ],
    },
    plugins: [
        // Handles `?svg&icon` queries produced by `js/icons.ts`.
        svgUse(),
        // Mark the bundled entry executable after build (matches the shebang).
        chmodBinPlugin('monochrome-dl.js'),
    ],
    // Stub the browser-only `import.meta.env.DEV` check in `js/ffmpegFormats.ts`.
    define: {
        'import.meta.env.DEV': 'false',
    },
    ssr: {
        // Keep everything in node_modules external (default SSR behavior).
        // Our own `#js/*` code is bundled so its transitive virtual imports resolve.
        noExternal: [/^#js\//],
    },
    build: {
        ssr: 'cli/bin/monochrome-dl.ts',
        outDir: 'cli/dist',
        emptyOutDir: true,
        target: 'node20',
        rollupOptions: {
            // Optional runtime deps that users opt into via `npm i`; mark as
            // external so the CLI builds even when they aren't installed.
            external: [/^kuroshiro(-.+)?$/],
            output: {
                format: 'esm',
                entryFileNames: 'monochrome-dl.js',
            },
        },
        minify: false,
        sourcemap: true,
    },
});
