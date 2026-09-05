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

# HERMIT_MEASURE=1 prints the browser's own geometry instead of a screenshot:
# every element under #frame, with its classes and its bounding box in CSS pixels.
#
#   HERMIT_MEASURE=1 tools/render-web-list.sh
#
# This is how the row's box turned out to be 48.5pt while SwiftUI was giving it
# 43. No amount of reading Tailwind classes tells you what `text-[13px]` costs in
# HEIGHT — nothing in the row sets a line-height, so preflight's `line-height:
# 1.5` on <html> decides, and 13 × 1.5 = 19.5. Guess that number and you are
# comparing the port against another guess; ask Chrome and you have the web's own
# answer. Every screen M6 ports will want this first.
PROBE='<script>window.addEventListener("load",function(){var o=[],f=document.getElementById("frame");function b(e){var r=e.getBoundingClientRect();return r.left.toFixed(2)+","+r.top.toFixed(2)+" "+r.width.toFixed(2)+"x"+r.height.toFixed(2);}o.push("frame "+b(f));f.querySelectorAll("*").forEach(function(e,i){var c=getComputedStyle(e);o.push(i+" "+e.tagName.toLowerCase()+" ["+(e.className||"").toString().slice(0,56)+"] "+b(e)+" fs="+c.fontSize+"/"+c.lineHeight+" mt="+c.marginTop+" pt="+c.paddingTop+" gap="+c.columnGap);});var pre=document.createElement("pre");pre.id="MEASURE";pre.textContent=o.join("\n");document.body.appendChild(pre);});</script>'

for scheme in dark light; do
  ( cd "$REPO/apps/dashboard" && HERMIT_ROWS_FIXTURE="$IOS/tools/fixtures/session-rows.json" \
      "$NM/.bin/tsx" scripts/render-session-rows.tsx "$TMP/rows-$scheme.html" "$scheme" ) \
    2>&1 | grep -v "is not recognized as a valid pseudo-element" | grep -v '^\s*$' || true

  if [ -n "${HERMIT_MEASURE:-}" ]; then
    python3 -c 'import sys;p=sys.argv[1];s=open(p,encoding="utf8").read();open(p,"w",encoding="utf8").write(s.replace("</body>",sys.argv[2]+"</body>"))' \
      "$TMP/rows-$scheme.html" "$PROBE"
    # --dump-dom does not make Chrome exit either, so it gets the same
    # wait-for-the-output-then-kill treatment as the screenshot below.
    "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
      --user-data-dir="$TMP/profile-$scheme" --hide-scrollbars \
      --force-device-scale-factor=3 --window-size=320,"$HEIGHT" \
      --virtual-time-budget=2000 --dump-dom "file://$TMP/rows-$scheme.html" \
      > "$TMP/dom-$scheme.html" 2>/dev/null &
    chrome_pid=$!
    for _ in $(seq 1 100); do
      grep -q 'id="MEASURE"' "$TMP/dom-$scheme.html" 2>/dev/null && break
      sleep 0.2
    done
    kill "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
    echo "-- $scheme --"
    python3 -c 'import re,sys,html;d=open(sys.argv[1],encoding="utf8",errors="replace").read();m=re.search(r"<pre id=.MEASURE.>(.*?)</pre>",d,re.S);print(html.unescape(m.group(1)) if m else "chrome dumped no MEASURE block")' \
      "$TMP/dom-$scheme.html"
    continue
  fi

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
