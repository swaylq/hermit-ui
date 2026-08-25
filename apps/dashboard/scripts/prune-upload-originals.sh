#!/usr/bin/env bash
# Delete the full-size upload originals that nothing links to.
#
# /api/upload used to write two files per image: `<uuid>.<ext>` (the bytes as
# uploaded) and `<uuid>.safe.<ext>` (long edge =<2000px). Only the ".safe." one
# is ever referenced — by the stored message block, the gateway relay, the
# lightbox, and now the thumbnail. `originalUrl` was returned by the API and read
# by nobody. Measured on the deploy box 2026-08-25: 4,747 originals / 8.4 GB
# against 3,219 reachable files / 1.7 GB, on a disk that was 80% full.
#
# The route no longer writes them. This clears the ones already there.
#
# An original is deleted only when ALL of these hold:
#   - a sibling `<uuid>.safe.<ext>` exists (so the picture is still reachable)
#   - it is older than KEEP_DAYS (default 30), so anything recent is left alone
#   - its name is a bare `<uuid>.<ext>` — never a .safe. / .thumb. / .src. file
#
# Usage: KEEP_DAYS=30 apps/dashboard/scripts/prune-upload-originals.sh [--apply]
# Default is a dry run; pass --apply to actually delete.

set -uo pipefail

DIR="${UPLOAD_DIR:-/var/hermit-ui/uploads}"
KEEP_DAYS="${KEEP_DAYS:-30}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ -d "$DIR" ] || { echo "upload dir not found: $DIR" >&2; exit 1; }

freed=0
count=0
kept_no_safe=0

while IFS= read -r f; do
  base="${f##*/}"
  # skip our own derived files
  case "$base" in *.safe.*|*.thumb.webp|*.src.*) continue;; esac
  stem="${f%.*}"; ext="${f##*.}"
  [ -f "${stem}.safe.${ext}" ] || { kept_no_safe=$((kept_no_safe+1)); continue; }
  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
  freed=$((freed+sz)); count=$((count+1))
  [ "$APPLY" = 1 ] && rm -f "$f"
done < <(find "$DIR" -type f -mtime "+${KEEP_DAYS}")

verb="would delete"; [ "$APPLY" = 1 ] && verb="deleted"
echo "$verb $count originals, $((freed/1024/1024)) MB (older than ${KEEP_DAYS}d, .safe. sibling present)"
echo "left alone (no .safe. sibling — the only copy): $kept_no_safe"
