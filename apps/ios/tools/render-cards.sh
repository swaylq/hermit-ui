#!/usr/bin/env bash
# Draw the Live Activity layouts to PNGs so a change can be looked at before it
# ships. Not part of any target.
#
#   apps/ios/tools/render-cards.sh [outdir]     # default: $TMPDIR/hermit-cards
#
# Compiles the presentation for macOS — which is possible only because
# SessionCardViews.swift takes a plain SessionCard and imports no ActivityKit.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-${TMPDIR:-/tmp}hermit-cards}"
mkdir -p "$OUT"
BIN="$(mktemp -d)/render-cards"
swiftc -O -o "$BIN" \
  Shared/SessionCard.swift Shared/StatusPalette.swift Shared/WebContract.swift \
  LiveActivity/SessionCardViews.swift tools/render-cards.swift
"$BIN" ../dashboard/public/logo-crab-mono.png "$OUT"
echo "→ $OUT"
