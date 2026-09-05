#!/usr/bin/env bash
# Draw the press-and-hold overlay twice — the SwiftUI one and the REAL React one
# — off one table, and subtract them.
#
#   apps/ios/tools/hold-compare.sh [outdir]
#
# Both halves read tools/fixtures/hold-states.json and both draw at 3×, so the
# two PNGs are the same size and png-diff can subtract them without alignment.
# Writes hold-overlay-*.png, web-hold-overlay.png and diff-hold-overlay.png, and
# prints the percentage of pixels that differ.
#
# The overlay is drawn over black on both sides: what is behind a `bg-black/70`
# scrim and a 3px blur is not what this comparison is about.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

./tools/render-hold.sh "$OUT" | sed 's/^/native  /'
./tools/render-web-hold.sh "$OUT" | sed 's/^/web     /'

BIN="$(mktemp -d)/png-diff"
swiftc -O -o "$BIN" tools/png-diff.swift
"$BIN" "$OUT/hold-overlay.png" "$OUT/web-hold-overlay.png" "$OUT/diff-hold-overlay.png"
