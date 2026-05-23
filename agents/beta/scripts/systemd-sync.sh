#!/bin/bash
# Sync an agent's systemd/*.{service,timer} → ~/.config/systemd/user/ and
# enable/start each timer.
#
# Why this exists: during agent migrations, units get generated into
# <agent>/systemd/ but are easy to forget to copy + enable. Result: the agent
# thinks its crons are live but they never fire. This script makes the sync
# idempotent and reportable.
#
# Usage:
#   scripts/systemd-sync.sh <agent-dir> [--dry-run]
#
# Source files in <agent-dir>/systemd/<task>.<service|timer> get installed as
# hermit-<agent>-<task>.<service|timer> in the user systemd dir. Each timer
# must have a matching service of the same base name.
#
# Behavior:
#   - New service+timer pair → copy + daemon-reload + enable --now timer
#   - Changed file → copy + daemon-reload + restart timer
#   - Identical → skip (timer left running)
#   - Extra unit in ~/.config/systemd/user with matching prefix but no source
#     → WARN, don't delete (so manual additions survive)
#
# Server note: systemd --user units stop when the user logs out unless
# lingering is enabled. Run once: `loginctl enable-linger $USER` (may need sudo).

set -u

AGENT_DIR=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) AGENT_DIR="$arg" ;;
  esac
done

if [ -z "$AGENT_DIR" ] || [ ! -d "$AGENT_DIR/systemd" ]; then
  echo "Usage: $0 <agent-dir> [--dry-run]" >&2
  echo "  expects <agent-dir>/systemd/*.{service,timer}" >&2
  exit 1
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"

agent_name=$(basename "$AGENT_DIR")
prefix="hermit-${agent_name}"

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
need_reload=0

shopt -s nullglob
srcs=("$AGENT_DIR"/systemd/*.service "$AGENT_DIR"/systemd/*.timer)
if [ ${#srcs[@]} -eq 0 ]; then
  echo "No service/timer files found in $AGENT_DIR/systemd/"
  exit 0
fi

# Pass 1: copy / update files
for src in "${srcs[@]}"; do
  base=$(basename "$src")
  task="${base%.*}"
  ext="${base##*.}"
  tgt_name="${prefix}-${task}.${ext}"
  tgt="$UNIT_DIR/$tgt_name"

  if [ ! -f "$tgt" ]; then
    run cp "$src" "$tgt"
    echo "INSTALL ${tgt_name}"
    need_reload=1
    [ "$ext" = "timer" ] && ((added++))
  elif ! diff -q "$src" "$tgt" >/dev/null 2>&1; then
    run cp "$src" "$tgt"
    echo "UPDATE  ${tgt_name}"
    need_reload=1
    [ "$ext" = "timer" ] && ((updated++))
  else
    [ "$ext" = "timer" ] && ((skipped++))
  fi
done

if [ "$need_reload" -eq 1 ]; then
  run systemctl --user daemon-reload
fi

# Pass 2: enable+start every timer that has a source. is-active short-circuits
# the dance for already-running timers so daemon-reload's "Refusing to..." spam
# stays out of the output.
for src in "$AGENT_DIR"/systemd/*.timer; do
  [ -f "$src" ] || continue
  base=$(basename "$src")
  task="${base%.timer}"
  unit="${prefix}-${task}.timer"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY: systemctl --user enable --now $unit"
    continue
  fi
  if systemctl --user is-active --quiet "$unit"; then
    if ! systemctl --user restart "$unit" 2>/dev/null; then
      echo "ERROR   restart failed: $unit" >&2
      ((errors++))
    fi
  else
    if ! systemctl --user enable --now "$unit" 2>/dev/null; then
      echo "ERROR   enable failed: $unit" >&2
      ((errors++))
    fi
  fi
done

# Pass 3: warn on stray units (installed for this agent but no source)
shopt -s nullglob
for tgt in "$UNIT_DIR/${prefix}"-*.service "$UNIT_DIR/${prefix}"-*.timer; do
  [ -f "$tgt" ] || continue
  base=$(basename "$tgt")
  rest="${base#${prefix}-}"
  ext="${rest##*.}"
  task="${rest%.*}"
  src="$AGENT_DIR/systemd/${task}.${ext}"
  if [ ! -f "$src" ]; then
    echo "WARN    $base installed but no source in $AGENT_DIR/systemd/" >&2
    echo "        Remove with: systemctl --user disable --now $base; rm $tgt" >&2
  fi
done

echo
echo "Summary: $added installed, $updated reloaded, $skipped unchanged, $errors errors"

# Linger sanity check (server-side gotcha that bites first-time installs)
if command -v loginctl >/dev/null 2>&1; then
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes$'; then
    echo
    echo "WARNING: lingering NOT enabled for user '$USER'."
    echo "         systemd --user services will stop when you log out."
    echo "         Run once (may need sudo): loginctl enable-linger $USER"
  fi
fi

[ "$errors" -gt 0 ] && exit 2
exit 0
