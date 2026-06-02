#!/bin/bash
# Sync an agent's launchd/*.plist → ~/Library/LaunchAgents and load/reload.
#
# Why this exists: during agent migrations, plists get generated into
# <agent>/launchd/ but are easy to forget to copy + launchctl load. Result:
# the agent thinks its crons are live but they never fire. This script makes
# the sync idempotent and reportable.
#
# Usage:
#   scripts/launchd-sync.sh <agent-dir> [--dry-run]
#
# Behavior:
#   - New plist in <agent>/launchd/ → copy + launchctl load
#   - Changed plist → unload + copy + load
#   - Identical plist → skip
#   - Extra plist in ~/Library/LaunchAgents (no source) → WARN, don't delete

set -u

AGENT_DIR=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) AGENT_DIR="$arg" ;;
  esac
done

if [ -z "$AGENT_DIR" ] || [ ! -d "$AGENT_DIR/launchd" ]; then
  echo "Usage: $0 <agent-dir> [--dry-run]"
  echo "  expects <agent-dir>/launchd/*.plist"
  exit 1
fi

LA_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LA_DIR"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY: $*"
  else
    "$@"
  fi
}

added=0
updated=0
skipped=0
errors=0

shopt -s nullglob
srcs=("$AGENT_DIR"/launchd/*.plist)
if [ ${#srcs[@]} -eq 0 ]; then
  echo "No plists found in $AGENT_DIR/launchd/"
  exit 0
fi

for src in "${srcs[@]}"; do
  name=$(basename "$src")
  label="${name%.plist}"
  tgt="$LA_DIR/$name"

  if [ ! -f "$tgt" ]; then
    run cp "$src" "$tgt"
    if [ "$DRY_RUN" -eq 1 ] || launchctl load "$tgt" 2>/dev/null; then
      echo "LOADED  $label"
      ((added++))
    else
      echo "ERROR   $label (copied but load failed)"
      ((errors++))
    fi
  elif ! diff -q "$src" "$tgt" >/dev/null 2>&1; then
    run launchctl unload "$tgt" 2>/dev/null || true
    run cp "$src" "$tgt"
    if [ "$DRY_RUN" -eq 1 ] || launchctl load "$tgt" 2>/dev/null; then
      echo "RELOAD  $label"
      ((updated++))
    else
      echo "ERROR   $label (copied but reload failed)"
      ((errors++))
    fi
  else
    ((skipped++))
  fi
done

agent_name=$(basename "$AGENT_DIR")
for tgt in "$LA_DIR"/com.hermit-agent."$agent_name".cron-*.plist; do
  [ -f "$tgt" ] || continue
  name=$(basename "$tgt")
  src="$AGENT_DIR/launchd/$name"
  if [ ! -f "$src" ]; then
    echo "WARN    ${name%.plist} installed but no source plist in $AGENT_DIR/launchd/ (leave alone, or remove manually)"
  fi
done

echo
echo "Summary: $added loaded, $updated reloaded, $skipped unchanged, $errors errors"
[ "$errors" -gt 0 ] && exit 2
exit 0
