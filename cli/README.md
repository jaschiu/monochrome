# monochrome-dl

CLI tool for downloading Tidal tracks and albums via [Monochrome](https://github.com/monochrome-music/monochrome) proxy instances.

## Requirements

- **Node.js** ≥ 18
- **ffmpeg** and **ffprobe** on PATH (required for DASH streams and transcoding)

## Install

The CLI ships with the main Monochrome repository and is run through Vite
(either via `vite-node` for development, or via the pre-built bundle for
distribution). From the repo root:

```bash
bun install
```

## Usage

```bash
# Dev (TypeScript source via vite-node)
bun run cli -- 491206012            # single track
bun run cli -- 491206011            # album
bun run cli -- 491206011 491206012  # multiple IDs
bun run cli -- 491206011 -o ~/Music # custom output directory
bun run cli -- 491206011 -v         # verbose logging

# Distribution build
bun run cli:build                   # produces cli/dist/monochrome-dl.js
node cli/dist/monochrome-dl.js 491206012
```

## Quality Options

| Flag | Description |
|------|-------------|
| `-q HI_RES_LOSSLESS` | Hi-Res FLAC (default) |
| `-q LOSSLESS` | CD-quality FLAC |
| `-q HIGH` | AAC 320kbps |
| `-q LOW` | HE-AAC 96kbps |
| `-q FFMPEG_MP3_320` | Transcode to MP3 320kbps |
| `-q FFMPEG_MP3_256` | Transcode to MP3 256kbps |
| `-q FFMPEG_MP3_128` | Transcode to MP3 128kbps |
| `-q FFMPEG_OGG_320` | Transcode to OGG 320kbps |
| `-q FFMPEG_OGG_256` | Transcode to OGG 256kbps |
| `-q FFMPEG_OGG_128` | Transcode to OGG 128kbps |
| `-q FFMPEG_OPUS_320` | Transcode to Opus 320kbps (also 256/160/128/96) |
| `-q FFMPEG_AAC_256` | Transcode to AAC 256kbps |
| `-q DOLBY_ATMOS` | Dolby Atmos (EAC3-JOC) |

The transcode list is read from `js/ffmpegFormats.ts`, so any format the web
app gains is accepted here automatically. Quality aliases understood by the
web app (`normalizeQualityToken`, e.g. `hifi_plus`) work too.

```bash
bun run cli -- 491206011 -q FFMPEG_MP3_320       # MP3 320
bun run cli -- 491206011 --atmos                 # prefer Dolby Atmos when available
bun run cli -- 491206011 --container alac        # convert lossless → ALAC
```

## Metadata & Extras

```bash
bun run cli -- 491206011 --lyrics                     # .lrc files
bun run cli -- 491206011 --lyrics --romaji            # Romaji conversion
bun run cli -- 491206011 --write-artists-separately   # multi-artist tags
bun run cli -- 491206011 --cover-size 640             # custom cover size
```

## Templates

```bash
bun run cli -- 491206011 --filename-template "{trackNumber}. {title}"
bun run cli -- 491206011 --folder-template "{albumArtist}/{year} - {albumTitle}"
```

**Available tokens:** `{trackNumber}`, `{discNumber}`, `{artist}`, `{title}`, `{album}`, `{albumArtist}`, `{albumTitle}`, `{year}`

## Sidecar Files

```bash
bun run cli -- 491206011 --m3u --m3u8 --cue --nfo --json
bun run cli -- 491206011 --no-m3u
bun run cli -- 491206011 --separate-discs
```

## Instances

Defaults come from `apiSettings` in `js/storage.js` — the same uptime-worker
lookup, blocklist and fallback list the website uses — so the CLI never drifts
onto instances the web app has dropped.

```bash
bun run cli -- 491206011 --instance https://my-instance.example.com
bun run cli -- 491206011 --instance https://my-instance.example.com --no-default-instances
```

## Streaming sources

Tidal `/trackManifests/` is tried first, then the web app's remaining
headless-capable fallbacks by ISRC: Qobuz, then Deezer. (Amazon Music, which
upstream prefers in the browser, needs Cloudflare Turnstile and CENC
decryption, so it is not usable from the CLI.)

Tidal audio URLs go through the same audio proxy as the web app. The browser
needs it for CORS; the CLI does not, so if the proxy is unreachable the
download retries directly instead of failing. Pass `--no-audio-proxy` to skip
it entirely, e.g. when using `--socks5-proxy`.

## Info subcommand

Print metadata for tracks/albums without downloading. Status logs go to
stderr; the metadata block goes to stdout, so JSON output is safe to pipe
into `jq` or similar tools.

```bash
bun run cli -- info 491206012                # human-friendly track info
bun run cli -- info 491206011                # album info + per-track summary
bun run --silent cli -- info -f json 491206011 | jq .   # JSON output (note --silent)
bun run --silent cli -- info -f json 491206011 > out.json
```

**Piping JSON:** `bun run` and `npm run` print a script banner (e.g.
`> monochrome@2.5.1 cli ...`) to stdout, which will corrupt redirected
JSON output. Pass `--silent` (or `-s` for npm) to suppress it, or invoke
the built bundle directly (`node cli/dist/monochrome-dl.js info -f json ...`)
to avoid the wrapper entirely.

Track output includes `audioQuality` (the enum, e.g. `HI_RES_LOSSLESS`,
`LOSSLESS`, `HIGH`, `LOW`), `audioModes`, `mediaTags`, primary and full
artist list, album summary, track/disc position, duration, ISRC, copyright,
release date, and URL. Album output adds release date, UPC, and (when the
album has more than one track) a one-line summary per track.

Flags: `-f, --format <text|json>` (default `text`), `--concurrency <n>`
(parallel input fetches, default 3), plus the same `--instance`,
`--no-default-instances`, `--socks5-proxy`, `--mullvad-relays`, `--no-cache`,
and `-v, --verbose` flags as the download command. Inputs are fetched in
parallel; output is always emitted in the order the IDs were passed.

## Cache

API responses are cached in `~/.cache/monochrome/`.

```bash
bun run cli -- --clear-cache
bun run cli -- 491206011 --no-cache
```

## Tests

```bash
bun run cli:test         # download E2E harness; requires ffmpeg + ffprobe on PATH
./cli/test/e2e.sh        # same harness, invoked directly
bun run cli:test:proxy   # cuimp + Mullvad SOCKS5 checks (network-dependent)
```

Both are standalone scripts rather than vitest specs; `npm test` runs the web
suite in a browser, where these Node-only checks can't execute.
