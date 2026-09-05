#!/usr/bin/env bash
# Draw the native session list to PNGs so a change can be looked at before it
# ships — on this Mac, no simulator. Not part of any target.
#
#   apps/ios/tools/render-list.sh [outdir]     # default: apps/ios/shots
#
# Possible only because SessionRowView.swift is SwiftUI over a plain
# SessionListItem: no UIKit, no networking, no ActivityKit. Same trick as
# render-cards.sh, one screen further in.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
BIN="$(mktemp -d)/render-list"
swiftc -O -o "$BIN" \
  Shared/StatusPalette.swift Shared/WebContract.swift Hermit/WebLayout.swift \
  Hermit/SessionStatus.swift Hermit/SessionListItem.swift Hermit/SessionRowView.swift \
  Hermit/SessionListSkeleton.swift \
  tools/render-list.swift
"$BIN" "$OUT"
echo "→ $OUT"
