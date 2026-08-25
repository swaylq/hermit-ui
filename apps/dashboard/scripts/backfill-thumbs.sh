#!/usr/bin/env bash
# Warm the 640px WebP thumbnails for images uploaded before thumbnails existed.
#
# Not required for correctness — /uploads/[...path] mints a missing thumbnail on
# first request — but the first reader of an old picture otherwise waits ~113ms
# for imagemagick. Running this once means nobody does.
#
# Usage:  UPLOAD_DIR=/var/hermit-ui/uploads apps/dashboard/scripts/backfill-thumbs.sh [--dry-run]
# Safe to re-run: existing thumbnails are skipped. GIFs are skipped on purpose
# (a WebP re-encode either drops the animation or grows).
#
# The `webp:` prefix on the output is load-bearing: imagemagick takes its output
# format from the extension, and we write to a `.tmp` name first.

set -uo pipefail

DIR="${UPLOAD_DIR:-/var/hermit-ui/uploads}"
JOBS="${JOBS:-4}"
LONG_EDGE=640
QUALITY=75
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

command -v convert >/dev/null 2>&1 || { echo "convert (imagemagick) not found" >&2; exit 1; }
[ -d "$DIR" ] || { echo "upload dir not found: $DIR" >&2; exit 1; }

mapfile -t TODO < <(
  find "$DIR" -type f \( -name '*.safe.png' -o -name '*.safe.jpg' -o -name '*.safe.jpeg' -o -name '*.safe.webp' \) \
  | while read -r f; do
      stem="${f%.safe.*}"
      [ -f "${stem}.thumb.webp" ] || echo "$f"
    done
)

echo "candidates: ${#TODO[@]} (dir=$DIR jobs=$JOBS)"
[ "${#TODO[@]}" -eq 0 ] && exit 0
if [ "$DRY" = 1 ]; then
  printf '%s\n' "${TODO[@]}" | head -5
  echo "... dry run, nothing written"
  exit 0
fi

printf '%s\0' "${TODO[@]}" | xargs -0 -P "$JOBS" -I{} bash -c '
  f="$1"; stem="${f%.safe.*}"; out="${stem}.thumb.webp"; tmp="${out}.$$.tmp"
  if convert "${f}[0]" -resize "'"$LONG_EDGE"'x'"$LONG_EDGE"'>" -depth 8 -strip -quality '"$QUALITY"' "webp:$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv -f "$tmp" "$out"
  else
    rm -f "$tmp"
    echo "FAIL $f" >&2
  fi
' _ {}

made=$(find "$DIR" -type f -name '*.thumb.webp' | wc -l)
before=$(find "$DIR" -type f \( -name '*.safe.png' -o -name '*.safe.jpg' -o -name '*.safe.jpeg' -o -name '*.safe.webp' \) -printf '%s\n' | awk '{s+=$1} END {printf "%.0f", s/1024}')
after=$(find "$DIR" -type f -name '*.thumb.webp' -printf '%s\n' | awk '{s+=$1} END {printf "%.0f", s/1024}')
echo "thumbnails on disk: $made   safe-total: ${before}KB   thumb-total: ${after}KB"
