#!/usr/bin/env bash
# Draw the native chat timeline to PNGs so a change can be looked at before it
# ships — on this Mac, no simulator. Not part of any target.
#
#   apps/ios/tools/render-timeline.sh [outdir]    # default: apps/ios/shots
#
# Possible only because TimelineRowView.swift is SwiftUI over a FoldedRow: no
# UIKit, no networking, no ActivityKit. Same trick as render-list.sh, one screen
# further in — and the rows come out of the real FoldRuns.fold, so the picture
# is of what the fold decided, not of hand-posed rows.
#
# It also prints the three capsule label formatters over a table of inputs. The
# web's own values for the same inputs come from:
#
#   node --input-type=module -e "$(sed -n '/^function fmtDuration/,/^}/p;/^function fmtChars/,/^}/p;/^function namesLabel/,/^}/p' \
#     ../dashboard/src/components/chat/run-capsule.tsx)"
#
# — which is how the `1250 -> 1.3k` tie-rounding difference between JavaScript's
# toFixed and C's %.1f was found before it shipped.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
BIN="$(mktemp -d)/render-timeline"
swiftc -O -o "$BIN" \
  Shared/WebContract.swift Shared/StatusPalette.swift \
  Hermit/ContentBlock.swift Hermit/FoldRuns.swift \
  Hermit/SessionListItem.swift Hermit/SessionStatus.swift \
  Hermit/SessionMeta.swift Hermit/WebLabels.swift \
  Hermit/SessionRowView.swift Hermit/ChatHeaderView.swift \
  Hermit/TimelineRowView.swift \
  tools/render-timeline.swift
"$BIN" "$OUT"
echo "→ $OUT"
