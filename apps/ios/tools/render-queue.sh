#!/usr/bin/env bash
# Draw the native queue strip to PNGs — this Mac, no simulator, about 3 seconds.
#
#   apps/ios/tools/render-queue.sh [outdir]      # default: apps/ios/shots
#
# The web half is tools/render-web-queue.sh and the pair is tools/queue-compare.sh.
# Both read tools/fixtures/queue-bar.json, so the two PNGs are one table drawn
# twice rather than two tables.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
BIN="$(mktemp -d)/render-queue"
swiftc -O -o "$BIN" \
  Shared/WebContract.swift \
  Hermit/ContentBlock.swift Hermit/ComposerCore.swift \
  Hermit/QueueCore.swift Hermit/QueueBarView.swift Hermit/ComposerView.swift \
  Hermit/SessionRowView.swift Hermit/SessionListItem.swift Hermit/SessionStatus.swift \
  Hermit/WebLabels.swift Shared/StatusPalette.swift \
  tools/render-queue.swift
"$BIN" "$OUT" "$PWD/tools/fixtures/queue-bar.json"
echo "→ $OUT"
