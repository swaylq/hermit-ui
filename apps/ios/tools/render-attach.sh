#!/usr/bin/env bash
# Draw the native attachment strip to PNGs — this Mac, no simulator, ~3 seconds.
#
#   apps/ios/tools/render-attach.sh [outdir]     # default: apps/ios/shots
#
# The web half is tools/render-web-attach.sh and the pair is
# tools/attach-compare.sh. Both read tools/fixtures/attach-strip.json — including
# the thumbnail, which rides in the table as base64 so the two halves cannot
# draw different pictures.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
BIN="$(mktemp -d)/render-attach"
swiftc -O -o "$BIN" \
  Shared/WebContract.swift Hermit/WebLayout.swift \
  Hermit/AttachCore.swift Hermit/AttachmentChipView.swift \
  tools/render-attach.swift
"$BIN" "$OUT" "$PWD/tools/fixtures/attach-strip.json"
echo "→ $OUT"
