#!/usr/bin/env bash
# The WEB half of the press-and-hold comparison: draw the real HoldToTalkFace —
# components/chat/hold-to-talk.tsx, the component the dashboard ships — to a PNG
# on this Mac, with no database, no dev server and no key.
#
#   apps/ios/tools/render-web-hold.sh [outdir]
#
# Pairs with render-hold.sh (native, SwiftUI). Both read
# tools/fixtures/hold-states.json, so the two PNGs are one table drawn twice.
# tools/hold-compare.sh runs the pair and diffs them.
#
# HERMIT_MEASURE=1 prints the browser's own geometry instead of a screenshot —
# every element under the first frame with its box in CSS pixels. That is how you
# find out where an arc actually lands rather than guessing at it.
set -euo pipefail
cd "$(dirname "$0")/.."                       # apps/ios
IOS="$PWD"
REPO="$(cd ../.. && pwd)"
OUT="${1:-shots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

CHROME="${HERMIT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "no Chrome at $CHROME (set HERMIT_CHROME)" >&2; exit 1; }

# The dashboard's deps are installed at the repo root (hoisted, and the worktrees
# have no node_modules of their own) — see docs/ios-native-progress.md.
NM="$REPO/node_modules"
[ -d "$NM" ] || NM="$HOME/hermit-ui/node_modules"
[ -x "$NM/.bin/tsx" ] || { echo "no tsx under $NM — pnpm install at the repo root" >&2; exit 1; }

# The canvas: every case at full width, plus the gutters between them.
read -r W H <<EOF
$(python3 -c '
import json,sys
f=json.load(open(sys.argv[1]))
n=len(f["cases"])
print(f["width"]*n + f["gap"]*(n-1), f["height"])
' "$IOS/tools/fixtures/hold-states.json")
EOF

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── the viewport, which is not the window, EXCEPT when it is ────────────────
#
# The overlay's stage is `pb-[20vh]`, so both halves of this comparison are only
# honest if the browser's viewport is exactly the phone screen in the table. The
# two Chrome modes below disagree about what the viewport is, and the difference
# is 17 points of vertical drift on every screen:
#
#   --screenshot  expands the viewport to the whole page before capturing, so
#                 `--window-size $W,$H` gives innerHeight = H. Use H.
#   --dump-dom    does not, and headless Chrome keeps ~87px of the window for
#                 itself, so `--window-size $W,$H` gives innerHeight = H − 87.
#                 Use H + that reserve, measured below rather than assumed.
#
# Verified rather than reasoned: with H in both, the web clock lands on rows
# 943–961 of the PNG and the native one on 942–961 (tools/pixel-probe.sh).
cat > "$TMP/probe.html" <<'PROBEHTML'
<!doctype html><html><body><script>
document.body.textContent = "INNER:" + window.innerHeight;
</script></body></html>
PROBEHTML
# `--headless=new` does not exit after `--dump-dom` either (same as the
# screenshot below), so this is the same wait-then-kill dance.
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$TMP/probe-profile" --hide-scrollbars \
  --force-device-scale-factor=3 --window-size="$W","$H" \
  --virtual-time-budget=800 --dump-dom "file://$TMP/probe.html" \
  > "$TMP/probe-out.html" 2>/dev/null &
probe_pid=$!
for _ in $(seq 1 60); do
  grep -q 'INNER:' "$TMP/probe-out.html" 2>/dev/null && break
  sleep 0.2
done
kill "$probe_pid" 2>/dev/null || true
wait "$probe_pid" 2>/dev/null || true
INNER=$(sed -n 's/.*INNER:\([0-9]*\).*/\1/p' "$TMP/probe-out.html" | head -1)
[ -n "$INNER" ] || { echo "chrome would not report its viewport height" >&2; exit 1; }
WINDOW_H=$(( H + H - INNER ))
echo "viewport: asked for ${H}, got ${INNER} — using --window-size ${W},${WINDOW_H}"

PROBE='<script>window.addEventListener("load",function(){var o=["viewport "+innerWidth+"x"+innerHeight+" client "+document.documentElement.clientWidth+"x"+document.documentElement.clientHeight+" body "+document.body.scrollHeight];function b(e){var r=e.getBoundingClientRect();return r.left.toFixed(2)+","+r.top.toFixed(2)+" "+r.width.toFixed(2)+"x"+r.height.toFixed(2);}document.querySelectorAll(".frame").forEach(function(f,fi){o.push("== frame "+fi+" "+b(f));f.querySelectorAll("*").forEach(function(e,i){var c=getComputedStyle(e);o.push(fi+"."+i+" "+e.tagName.toLowerCase()+" ["+(e.className||"").toString().slice(0,50)+"] "+b(e)+" fs="+c.fontSize+"/"+c.lineHeight+" op="+c.opacity+" bw="+c.borderTopWidth);});});var pre=document.createElement("pre");pre.id="MEASURE";pre.textContent=o.join("\n");document.body.appendChild(pre);});</script>'

( cd "$REPO/apps/dashboard" && HERMIT_HOLD_FIXTURE="$IOS/tools/fixtures/hold-states.json" \
    "$NM/.bin/tsx" scripts/render-hold.tsx "$TMP/hold.html" ) \
  2>&1 | grep -v "is not recognized as a valid pseudo-element" | grep -v '^\s*$' || true

if [ -n "${HERMIT_MEASURE:-}" ]; then
  python3 -c 'import sys;p=sys.argv[1];s=open(p,encoding="utf8").read();open(p,"w",encoding="utf8").write(s.replace("</body>",sys.argv[2]+"</body>"))' \
    "$TMP/hold.html" "$PROBE"
  "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/profile" --hide-scrollbars \
    --force-device-scale-factor=3 --window-size="$W","$WINDOW_H" \
    --virtual-time-budget=2000 --dump-dom "file://$TMP/hold.html" \
    > "$TMP/dom.html" 2>/dev/null &
  chrome_pid=$!
  for _ in $(seq 1 100); do
    grep -q 'id="MEASURE"' "$TMP/dom.html" 2>/dev/null && break
    sleep 0.2
  done
  kill "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
  python3 -c 'import re,sys,html;d=open(sys.argv[1],encoding="utf8",errors="replace").read();m=re.search(r"<pre id=.MEASURE.>(.*?)</pre>",d,re.S);print(html.unescape(m.group(1)) if m else "chrome dumped no MEASURE block")' \
    "$TMP/dom.html"
  exit 0
fi

# Chrome writes the screenshot and then does NOT exit under --headless=new, so
# wait for the file to stop growing and take it down ourselves.
shot="$OUT/web-hold-overlay.png"
rm -f "$shot"
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$TMP/profile" --hide-scrollbars \
  --force-device-scale-factor=3 --window-size="$W","$H" \
  --virtual-time-budget=1500 --screenshot="$shot" \
  "file://$TMP/hold.html" >/dev/null 2>&1 &
chrome_pid=$!
for _ in $(seq 1 100); do
  [ -s "$shot" ] && sleep 0.4 && break
  sleep 0.2
done
kill "$chrome_pid" 2>/dev/null || true
wait "$chrome_pid" 2>/dev/null || true
[ -s "$shot" ] || { echo "chrome produced no $shot" >&2; exit 1; }
echo "wrote $(basename "$shot")  $(sips -g pixelWidth -g pixelHeight "$shot" | tail -2 | tr -d ' \n')"
echo "→ $OUT"
