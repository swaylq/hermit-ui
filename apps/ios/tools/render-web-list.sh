#!/usr/bin/env bash
# The WEB half of the session-list comparison: draw the real sidebar row —
# components/sidebar/session-row.tsx, the component the dashboard ships — to a PNG
# on this Mac, with no database, no dev server and no key.
#
#   apps/ios/tools/render-web-list.sh [outdir] [height-in-points]
#
# Pairs with render-list.sh (native, SwiftUI). Both read
# tools/fixtures/session-rows.json and both honour HERMIT_FIXTURE_NOW, so the two
# PNGs are one list drawn twice rather than two lists. tools/pixel-compare.sh runs
# the pair and diffs them; this script is also useful alone, to look at what the
# web actually draws without booting anything.
#
# Height defaults to whatever the native render came out as (320x485 points at
# scale 3 = 960x1455), so the two canvases line up and a layout difference shows
# up as pixels rather than as a size mismatch the differ has to paper over.
set -euo pipefail
cd "$(dirname "$0")/.."                       # apps/ios
IOS="$PWD"
REPO="$(cd ../.. && pwd)"
OUT="${1:-shots}"
HEIGHT="${2:-485}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

CHROME="${HERMIT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "no Chrome at $CHROME (set HERMIT_CHROME)" >&2; exit 1; }

# The dashboard's deps are installed at the repo root (hoisted, and the worktrees
# have no node_modules of their own) — see docs/ios-native-progress.md.
NM="$REPO/node_modules"
[ -d "$NM" ] || NM="$HOME/hermit-ui/node_modules"
[ -x "$NM/.bin/tsx" ] || { echo "no tsx under $NM — pnpm install at the repo root" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for scheme in dark light; do
  ( cd "$REPO/apps/dashboard" && HERMIT_ROWS_FIXTURE="$IOS/tools/fixtures/session-rows.json" \
      "$NM/.bin/tsx" scripts/render-session-rows.tsx "$TMP/rows-$scheme.html" "$scheme" ) \
    2>&1 | grep -v "is not recognized as a valid pseudo-element" | grep -v '^\s*$' || true

  # Chrome writes the screenshot and then does NOT exit under --headless=new, so
  # wait for the file to stop growing and take it down ourselves. Its own profile
  # in $TMP, so nothing here touches the browser the agent drives (and the
  # gateway's chrome-reaper only ever looks at pids in <agent>/browser/chrome.json).
  shot="$OUT/web-session-list-$scheme.png"
  rm -f "$shot"
  "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/profile-$scheme" --hide-scrollbars \
    --force-device-scale-factor=3 --window-size=320,"$HEIGHT" \
    --virtual-time-budget=1500 --screenshot="$shot" \
    "file://$TMP/rows-$scheme.html" >/dev/null 2>&1 &
  chrome_pid=$!
  for _ in $(seq 1 100); do
    [ -s "$shot" ] && sleep 0.4 && break
    sleep 0.2
  done
  kill "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
  [ -s "$shot" ] || { echo "chrome produced no $shot" >&2; exit 1; }
  echo "wrote $(basename "$shot")  $(sips -g pixelWidth -g pixelHeight "$shot" | tail -2 | tr -d ' \n')"
done
echo "→ $OUT"
