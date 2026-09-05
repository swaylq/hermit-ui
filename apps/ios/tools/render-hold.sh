#!/usr/bin/env bash
# Draw the native press-and-hold overlay to a PNG — this Mac, no simulator,
# ~3 seconds.
#
#   apps/ios/tools/render-hold.sh [outdir]      # default: apps/ios/shots
#
# The web half is tools/render-web-hold.sh and the pair is
# tools/hold-compare.sh. Both read tools/fixtures/hold-states.json, so the two
# PNGs are one table drawn twice.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
BIN="$(mktemp -d)/render-hold"
swiftc -O -o "$BIN" \
  Shared/WebContract.swift \
  Hermit/HoldCore.swift Hermit/WebLayout.swift Hermit/HoldToTalkView.swift \
  tools/render-hold.swift
"$BIN" "$OUT" "$PWD/tools/fixtures/hold-states.json"
echo "→ $OUT"
