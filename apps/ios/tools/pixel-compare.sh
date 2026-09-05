#!/usr/bin/env bash
# Draw the session list twice — native (SwiftUI, on this Mac) and web (the real
# components/sidebar/session-row.tsx through react-dom/server + headless Chrome) —
# off ONE fixture at ONE instant, then say where the two disagree.
#
#   apps/ios/tools/pixel-compare.sh [outdir]      # default: apps/ios/shots
#
# About 15 seconds, no simulator, no key, no database. This is the acceptance step
# M3 exists to hand to M6: every screen that gets ported gets a run of this.
#
# The two halves agree on their inputs or the comparison is theatre:
#   - the rows come from tools/fixtures/session-rows.json, read by both renderers;
#   - HERMIT_FIXTURE_NOW pins the clock both of them measure "12s ago" against;
#   - the frame is 320x485 points at scale 3 on both sides.
# What is left over after that is a real difference in how the two draw the row.
set -euo pipefail
cd "$(dirname "$0")/.."                       # apps/ios
OUT="${1:-shots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# One epoch for both sides. Whole seconds so nothing lands on a rounding edge
# between the two renders.
export HERMIT_FIXTURE_NOW="${HERMIT_FIXTURE_NOW:-$(( $(date +%s) * 1000 ))}"
echo "fixture now = $HERMIT_FIXTURE_NOW"

./tools/render-list.sh "$OUT" | sed 's/^/native: /'
H="$(sips -g pixelHeight "$OUT/session-list-dark.png" | tail -1 | tr -dc 0-9)"
./tools/render-web-list.sh "$OUT" "$(( H / 3 ))" | sed 's/^/web:    /'

BIN="$(mktemp -d)/png-diff"
swiftc -O -o "$BIN" tools/png-diff.swift
for scheme in dark light; do
  echo
  echo "── $scheme ────────────────────────────────────────────"
  # stderr swallowed on purpose: AppKit prints an "Unrecognized colorspace"
  # line per setColor call on a converted rep. Nothing this program says goes
  # there, so nothing is being hidden.
  "$BIN" "$OUT/session-list-$scheme.png" "$OUT/web-session-list-$scheme.png" \
         "$OUT/diff-session-list-$scheme.png" 2>/dev/null
done
echo
echo "→ $OUT"
