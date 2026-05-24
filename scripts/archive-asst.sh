#!/usr/bin/env bash
# Archive the old asst/dashboard + asst/gateway after the hermit-ui cutover
# has been verified in production. Idempotent — safe to re-run.
#
# What it does:
#   1. Stops (but does not delete) any pm2 processes named `asst-dashboard`
#      or `asst-gateway` on the local machine.
#   2. Drops a DEPRECATED.md banner into asst/dashboard/ and asst/gateway/
#      explaining the move + pointing readers at hermit-ui/.
#   3. `pm2 save` so the LaunchAgent resurrector forgets the old apps.
#
# It deliberately does NOT delete the source trees — that's a separate
# manual trash step once you've kept hermit-ui in production for ≥ a week
# without issue. Sequence:
#
#   1. Complete the VPS cutover per docs/deploy-vps.md (steps 1–9).
#   2. Run this script on the Mac (`./scripts/archive-asst.sh`).
#   3. Optional VPS-side equivalent: `pm2 delete asst-dashboard && pm2 save`.
#   4. After a clean week: `trash /Users/mac/claudeclaw/asst/{dashboard,gateway}`.

set -euo pipefail

ASST_ROOT="/Users/mac/claudeclaw/asst"
DASH_DIR="$ASST_ROOT/dashboard"
GW_DIR="$ASST_ROOT/gateway"

if [ ! -d "$DASH_DIR" ] && [ ! -d "$GW_DIR" ]; then
  echo "Neither $DASH_DIR nor $GW_DIR exists — already archived?"
  exit 0
fi

stop_pm2() {
  local name="$1"
  if pm2 describe "$name" >/dev/null 2>&1; then
    pm2 stop "$name" 2>&1 | tail -1
    echo "stopped: $name"
  else
    echo "not in pm2: $name (nothing to stop)"
  fi
}

write_deprecated() {
  local dir="$1"
  local appname="$2"
  [ -d "$dir" ] || { echo "skip: $dir doesn't exist"; return; }
  cat > "$dir/DEPRECATED.md" <<EOF
# DEPRECATED — moved to hermit-ui

This directory was the original \`$appname\` running under \`asst/\`. It has been forked, rewritten, and superseded by:

  /Users/mac/claudeclaw/asst/hermit-ui/apps/$appname/

Telegram was removed; chat now goes through the hermit-ui dashboard. See
\`hermit-ui/docs/deploy-vps.md\` for what runs where and \`hermit-ui/evolution/lessons.md\`
for the historical context.

If you opened this file looking for live code, **stop**. Edit hermit-ui instead.
You can safely \`trash $dir\` once the hermit-ui stack has been stable for ≥ a week.
EOF
  echo "wrote: $dir/DEPRECATED.md"
}

echo "→ Stopping pm2 processes"
stop_pm2 asst-dashboard
stop_pm2 asst-gateway

echo "→ Writing DEPRECATED.md banners"
write_deprecated "$DASH_DIR" "dashboard"
write_deprecated "$GW_DIR" "gateway"

echo "→ Persisting pm2 state"
pm2 save 2>&1 | tail -1

echo ""
echo "Done. To finish the cleanup later:"
echo "  trash $DASH_DIR $GW_DIR"
echo ""
echo "On the VPS:"
echo "  ssh ubuntu@45.89.234.110 -- 'pm2 delete asst-dashboard && pm2 save'"
