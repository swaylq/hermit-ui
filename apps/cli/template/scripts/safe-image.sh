#!/bin/bash
# safe-image.sh — Resize images so the long edge is ≤ MAX_PX before feeding to context.
#
# Backend-agnostic: sips on macOS, ImageMagick or Python PIL on Linux. The
# probing and the actual conversion live in lib/image.sh; this file is the
# policy — what counts as "safe", and what to do when nothing can tell.
#
# Usage: safe-image.sh <image-path> [max-px]
# Output: prints the safe path to stdout (original if already small, .safe.png if resized)
# Exit 0 on success, 1 on error, 2 when this machine has no image backend at all.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image.sh
. "$SCRIPT_DIR/lib/image.sh"

MAX_PX="${2:-1800}"
INPUT="${1:-}"

if [[ -z "$INPUT" ]]; then
  echo "usage: safe-image.sh <image-path> [max-px]" >&2
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "error: file not found: $INPUT" >&2
  exit 1
fi

# Loud, not silent. The caller (the pre-read hook) treats a failure here as
# "block the Read", and the HARD RULE says an image whose size we cannot verify
# must never reach context.
if [[ "$(image_backend)" == "none" ]]; then
  echo "error: no image backend on this machine (need sips, ImageMagick or Python pillow)." >&2
  echo "  install one with: $(image_backend_hint)" >&2
  exit 2
fi

if ! DIMS=$(image_dims "$INPUT"); then
  echo "error: cannot read dimensions of $INPUT (backend: $(image_backend))" >&2
  exit 1
fi
W=${DIMS% *}
H=${DIMS#* }

LONG=$(( W > H ? W : H ))

# Claude API rejects images by content-type derived from bytes, not extension.
# Only jpeg/png are universally safe; anything else (tiff, heic, gif, webp,
# bmp, …) must be transcoded to PNG even when it's already within MAX_PX.
# Past incident: 2026-05-14 — script wrote `.safe.png` containing TIFF bytes
# because `sips --resampleWidth` preserves source encoding by default. Every
# Read of that file 400'd with "Image format image/png not supported", and
# because the bad image stayed in context the next turn re-hit the same 400 —
# Stop hooks never fired, sessions wedged at state=running.
FMT=$(image_format "$INPUT" || echo "")
case "$FMT" in
  jpeg|jpg|png) NEEDS_TRANSCODE=0 ;;
  # An unknown format is transcoded rather than trusted: "we could not tell"
  # and "it is fine" are not the same answer.
  *)            NEEDS_TRANSCODE=1 ;;
esac

if (( LONG <= MAX_PX )) && [ "$NEEDS_TRANSCODE" -eq 0 ]; then
  # Already safe (within size limit AND in an API-supported format)
  echo "$INPUT"
  exit 0
fi

# Build output path: /path/to/file.jpg → /path/to/file.safe.png
DIR=$(dirname "$INPUT")
BASE=$(basename "$INPUT")
NAME="${BASE%.*}"
SAFE="$DIR/${NAME}.safe.png"

RESIZE=""
if (( LONG > MAX_PX )); then RESIZE="$MAX_PX"; fi

if ! image_to_png "$INPUT" "$SAFE" "$RESIZE"; then
  echo "error: failed to write $SAFE (backend: $(image_backend))" >&2
  rm -f "$SAFE"
  exit 1
fi

echo "$SAFE"
