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
| `-q FFMPEG_AAC_256` | Transcode to AAC 256kbps |

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

```bash
bun run cli -- 491206011 --instance https://my-instance.example.com
bun run cli -- 491206011 --instance https://my-instance.example.com --no-default-instances
```

## Cache

API responses are cached in `~/.cache/monochrome/`.

```bash
bun run cli -- --clear-cache
bun run cli -- 491206011 --no-cache
```

## Tests

```bash
bun run cli:test        # requires ffmpeg + ffprobe on PATH
./cli/test/e2e.sh       # equivalent bash harness
```
