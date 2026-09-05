#!/usr/bin/env bash
# Draw the native composer to PNGs so a change can be looked at before it ships —
# on this Mac, no simulator.
#
#   apps/ios/tools/render-composer.sh [outdir]    # default: apps/ios/shots
#
# Possible only because ComposerView.swift is SwiftUI over a plain value: no
# UIKit, no networking. Same trick as render-timeline.sh. The states are built
# through ComposerCore rather than posed, so what the box says in a picture is
# what it will say on the phone.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
BIN="$(mktemp -d)/render-composer"
swiftc -O -o "$BIN" \
  Shared/WebContract.swift \
  Hermit/ContentBlock.swift Hermit/ComposerCore.swift Hermit/ComposerView.swift \
  Hermit/QueueCore.swift Hermit/QueueBarView.swift \
  Hermit/SessionRowView.swift Hermit/SessionListItem.swift Hermit/SessionStatus.swift \
  Hermit/WebLabels.swift Shared/StatusPalette.swift \
  tools/render-composer.swift
"$BIN" "$OUT"
echo "→ $OUT"
