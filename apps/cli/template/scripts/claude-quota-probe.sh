#!/bin/bash
# Spawn a throwaway Claude Code REPL in an isolated tmux session, drive its
# /status panel to the Usage tab, capture the rendered pane, parse out the 5h
# block + weekly quota numbers, then tear everything down.
#
# Used by multi-agent-status-report.sh to surface live quota in the digest.
# Outputs key=value lines on stdout for eval consumption; exits non-zero on
# probe failure so the caller can fall back to ccusage-only data.
#
# Why this exists: Claude Code's quota live state is only on the cloud and
# only rendered via the interactive /status panel. There is no
# `claude --status --json` flag (verified Claude Code 2.1.x). Spawning a
# fresh REPL each cycle keeps existing active agents undisturbed.

set -u
# launchd's Aqua session ships a tiny default PATH (/usr/bin:/bin:/usr/sbin:/sbin)
# and `claude` is usually installed at ~/.local/bin/claude (see Claude Code's
# install-script default). Without this prepend, `command -v claude` returns
# nothing under launchd and the probe silently degrades — only the ccusage
# section comes through, the 5h/weekly quota lines disappear.
export PATH=$HOME/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

PROBE_DIR="${PROBE_DIR:-/tmp/_quota_probe}"
# Claude Code encodes the cwd into the projects dir; /private/tmp/_quota_probe
# becomes -private-tmp--quota-probe. Match the encoding so cleanup hits the
# right path even if PROBE_DIR is overridden.
PROJECTS_LEFTOVER="$HOME/.claude/projects/$(echo "$PROBE_DIR" | sed 's|/private||; s|^|/private|; s|/|-|g')"
LOCK_DIR=/tmp/.claude-quota-probe.lock
SESSION_NAME="_qp_$$"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"

if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "PROBE_OK=0" >&2
  exit 1
fi

# Single-instance lock via mkdir (atomic on macOS, no flock needed). If a
# previous probe died without cleanup the directory could be stale; treat
# locks older than 2 min as orphans and steal them.
if [ -d "$LOCK_DIR" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 120 ]; then
    echo "PROBE_OK=0" >&2
    exit 2
  fi
  rmdir "$LOCK_DIR" 2>/dev/null
fi
mkdir "$LOCK_DIR" 2>/dev/null || { echo "PROBE_OK=0" >&2; exit 2; }

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null
  # Remove the empty JSONL the probe REPL created. The probe has no API calls,
  # so the file only contains metadata lines and no usage to report.
  if [ -d "$PROJECTS_LEFTOVER" ]; then
    rm -f "$PROJECTS_LEFTOVER"/*.jsonl 2>/dev/null
    rmdir "$PROJECTS_LEFTOVER" 2>/dev/null
  fi
  rmdir "$LOCK_DIR" 2>/dev/null
}
trap cleanup EXIT

mkdir -p "$PROBE_DIR"

# Spawn detached. Sending the cd+claude invocation via send-keys (rather than
# passing it as the new-session command) avoids a silent-pane-on-binary-not-
# found failure mode where the pane stays empty and the session looks dead.
tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50 2>/dev/null
tmux send-keys -t "$SESSION_NAME" \
  "cd $PROBE_DIR && $CLAUDE_BIN --dangerously-skip-permissions" Enter

# Wait for the trust-folder prompt or the bare ❯ idle prompt.
for _ in $(seq 1 15); do
  pane=$(tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null)
  if echo "$pane" | grep -q "Yes, I trust this folder"; then
    tmux send-keys -t "$SESSION_NAME" Enter
    break
  fi
  if echo "$pane" | grep -qE "^❯[[:space:]]*$"; then
    break
  fi
  sleep 1
done

# Now wait for the REPL to settle at ❯.
for _ in $(seq 1 15); do
  pane=$(tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null)
  if echo "$pane" | grep -qE "^❯[[:space:]]*$"; then
    break
  fi
  sleep 1
done

# Open /status, Tab → Config, Tab → Usage. Wait for the cloud quota fetch to
# land (the panel renders "Loading usage data…" until then; we poll for the
# "Resets" line which only appears post-load). Cap the wait at 12s; if the
# fetch never lands the panel still has "Loading usage data…" and we report
# probe failure.
tmux send-keys -t "$SESSION_NAME" "/status" Enter
sleep 2
tmux send-keys -t "$SESSION_NAME" Tab
sleep 1
tmux send-keys -t "$SESSION_NAME" Tab

panel=""
for _ in $(seq 1 12); do
  panel=$(tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null)
  if echo "$panel" | grep -q "Current week"; then
    break
  fi
  sleep 1
done

# Dismiss panel + exit REPL. cleanup trap will kill the tmux session anyway,
# but doing it cleanly avoids leaving the JSONL transcript with an unclean
# shutdown line.
tmux send-keys -t "$SESSION_NAME" Escape
sleep 1
tmux send-keys -t "$SESSION_NAME" "/exit" Enter
sleep 1

# Parse. The Usage tab layout (Claude Code 2.1.x):
#
#   Current session
#   █████████                           18% used
#   Resets 7:20am (Asia/Shanghai)
#
#   Current week (all models)
#   ███████                             14% used
#   Resets May 3 at 12am (Asia/Shanghai)
#
#   Current week (Sonnet only)
#                                       0% used
#
# We pluck the percentage from the line directly under each header, and the
# reset line right after. macOS awk lacks match-with-array so we post-process
# via sed to extract the integer.

if ! echo "$panel" | grep -q "Current week"; then
  echo "PROBE_OK=0"
  exit 1
fi

extract_pct() {
  awk -v h="$1" '
    $0 ~ h { found=1; next }
    found && /[0-9]+% used/ { print; exit }
  ' <<< "$panel" | sed -E 's/.*[^0-9]([0-9]+)% used.*/\1/'
}

extract_reset() {
  awk -v h="$1" '
    $0 ~ h { found=1; next }
    found && /Resets / {
      sub(/^[[:space:]]+/, "")
      sub(/^Resets /, "")
      print; exit
    }
  ' <<< "$panel"
}

PCT_5H=$(extract_pct "Current session")
RESET_5H=$(extract_reset "Current session")
PCT_WEEKLY=$(extract_pct "Current week .all models.")
RESET_WEEKLY=$(extract_reset "Current week .all models.")
PCT_SONNET=$(extract_pct "Current week .Sonnet only.")

# Default to 0 rather than failing the whole probe — Sonnet section may
# legitimately not render if no usage at all.
[ -z "$PCT_5H" ] && PCT_5H=0
[ -z "$PCT_WEEKLY" ] && PCT_WEEKLY=0
[ -z "$PCT_SONNET" ] && PCT_SONNET=0

cat <<EOF
PROBE_OK=1
QUOTA_5H_PCT=$PCT_5H
QUOTA_5H_RESET="$RESET_5H"
QUOTA_WEEKLY_PCT=$PCT_WEEKLY
QUOTA_WEEKLY_RESET="$RESET_WEEKLY"
QUOTA_SONNET_PCT=$PCT_SONNET
EOF
