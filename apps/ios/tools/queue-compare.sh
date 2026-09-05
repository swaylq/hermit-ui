#!/usr/bin/env bash
# Draw the queue strip twice — native (SwiftUI, this Mac) and web (the real
# QueueBar through react-dom/server + headless Chrome) — off ONE table, then say
# where the two disagree.
#
#   apps/ios/tools/queue-compare.sh [outdir]     # default: apps/ios/shots
#
# About 15 seconds, no simulator, no key, no database. Sibling of
# pixel-compare.sh, which does the same for the session list; both are the
# acceptance step every ported screen gets.
set -euo pipefail
cd "$(dirname "$0")/.."                       # apps/ios
OUT="${1:-shots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

./tools/render-queue.sh "$OUT" | sed 's/^/native: /'
H="$(sips -g pixelHeight "$OUT/queue-strip-dark.png" | tail -1 | tr -dc 0-9)"
./tools/render-web-queue.sh "$OUT" "$(( H / 3 ))" | sed 's/^/web:    /'

BIN="$(mktemp -d)/png-diff"
swiftc -O -o "$BIN" tools/png-diff.swift
for scheme in dark light; do
  echo
  echo "── $scheme ────────────────────────────────────────────"
  # stderr swallowed on purpose: AppKit prints an "Unrecognized colorspace" line
  # per setColor call on a converted rep. Nothing this program says goes there.
  "$BIN" "$OUT/queue-strip-$scheme.png" "$OUT/web-queue-strip-$scheme.png" \
         "$OUT/diff-queue-strip-$scheme.png" 2>/dev/null
done
echo
echo "→ $OUT"
