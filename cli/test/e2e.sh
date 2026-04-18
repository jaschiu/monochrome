#!/usr/bin/env bash
# E2E tests for monochrome-dl CLI
# Usage: ./cli/test/e2e.sh
#
# Prerequisites: ffmpeg, ffprobe on PATH; network access to a monochrome instance.
# Exit code 0 = all tests passed; non-zero = at least one failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="bun run --cwd $REPO_ROOT cli --"
OUT=$(mktemp -d "/tmp/monochrome-e2e-XXXXXX")
PASS=0
FAIL=0

cleanup() { rm -rf "$OUT"; }
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); echo "  ✔ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✖ $1" >&2; }

assert_file() {
    if [ -f "$1" ]; then ok "$2"; else fail "$2 — file not found: $1"; fi
}

assert_glob() {
    # $1 = glob pattern, $2 = label
    # shellcheck disable=SC2086
    if compgen -G $1 > /dev/null 2>&1; then ok "$2"; else fail "$2 — no match: $1"; fi
}

assert_min_size() {
    # $1 = file, $2 = min bytes, $3 = label
    if [ -f "$1" ]; then
        local size
        size=$(stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null)
        if [ "$size" -ge "$2" ]; then ok "$3"; else fail "$3 — size $size < $2"; fi
    else
        fail "$3 — file not found: $1"
    fi
}

# ─────────────────────────────────────────────
# Test 1: Single track download (FLAC + metadata)
# ─────────────────────────────────────────────
echo ""
echo "Test 1: Single track download"
TRACK_ID=491206012   # Rick Astley – Never Gonna Give You Up
TRACK_DIR="$OUT/single"
$CLI "$TRACK_ID" -o "$TRACK_DIR" --no-m3u 2>/dev/null

assert_glob "'$TRACK_DIR'/*.flac" "FLAC file created"
FLAC_FILE=$(find "$TRACK_DIR" -name '*.flac' | head -1)
assert_min_size "$FLAC_FILE" 1000000 "FLAC file > 1 MB"

# Verify metadata via ffprobe
if [ -n "$FLAC_FILE" ] && [ -f "$FLAC_FILE" ]; then
    META=$(ffprobe -v quiet -show_entries format_tags -of flat "$FLAC_FILE" 2>/dev/null || true)
    if echo "$META" | grep -qi "title"; then ok "Metadata: title present"; else fail "Metadata: title missing"; fi
    if echo "$META" | grep -qi "artist"; then ok "Metadata: artist present"; else fail "Metadata: artist missing"; fi
fi

# ─────────────────────────────────────────────
# Test 2: Album download (tracks + cover + sidecars)
# ─────────────────────────────────────────────
echo ""
echo "Test 2: Album download with sidecars"
ALBUM_ID=75413011    # Rick Astley – Whenever You Need Somebody
ALBUM_DIR="$OUT/album"
$CLI "$ALBUM_ID" -o "$ALBUM_DIR" --cue --json 2>/dev/null

# Find the album subfolder
ALBUM_SUBFOLDER=$(find "$ALBUM_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)
if [ -z "$ALBUM_SUBFOLDER" ]; then
    fail "Album subfolder not created"
else
    TRACK_COUNT=$(find "$ALBUM_SUBFOLDER" -name '*.flac' | wc -l)
    if [ "$TRACK_COUNT" -ge 2 ]; then ok "Multiple FLAC tracks ($TRACK_COUNT)"; else fail "Expected ≥2 FLAC tracks, got $TRACK_COUNT"; fi

    assert_file "$ALBUM_SUBFOLDER/cover.jpg" "cover.jpg present"
    assert_glob "'$ALBUM_SUBFOLDER'/*.m3u" "M3U playlist present"
    assert_glob "'$ALBUM_SUBFOLDER'/*.cue" "CUE sheet present"
    assert_glob "'$ALBUM_SUBFOLDER'/*.json" "JSON metadata present"
fi

# ─────────────────────────────────────────────
# Test 3: Custom format transcoding (MP3 320)
# ─────────────────────────────────────────────
echo ""
echo "Test 3: Transcode to MP3 320"
MP3_DIR="$OUT/mp3"
$CLI "$TRACK_ID" -o "$MP3_DIR" -q FFMPEG_MP3_320 --no-m3u 2>/dev/null

assert_glob "'$MP3_DIR'/*.mp3" "MP3 file created"
MP3_FILE=$(find "$MP3_DIR" -name '*.mp3' | head -1)
if [ -n "$MP3_FILE" ] && [ -f "$MP3_FILE" ]; then
    CODEC=$(ffprobe -v quiet -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$MP3_FILE" 2>/dev/null || true)
    if [ "$CODEC" = "mp3" ]; then ok "Codec is mp3"; else fail "Expected mp3 codec, got: $CODEC"; fi
fi

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Passed: $PASS   Failed: $FAIL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[ "$FAIL" -eq 0 ] || exit 1
