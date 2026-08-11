#!/bin/bash
# Unified state hook for UserPromptSubmit / PreToolUse / Stop.
# Writes to $CLAUDE_PROJECT_DIR/.claude/state/session-status.json for the status reporter to read.
# Fully project-relative — no hardcoded agent paths.

set -u

# jq or node, whichever this machine has — Ubuntu ships neither jq nor a
# /usr/bin/jq symlink, and this hook parsing nothing meant the dashboard's
# turn-state went permanently stale without a single error line.
# shellcheck source=./lib/json.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/json.sh"

# Checked in the parent shell — see the note in lib/json.sh about why a guard
# inside `$(…)` cannot stop this script. This hook only REPORTS state, so with
# no parser it exits 0 and leaves the file untouched: a stale turn-state is bad,
# but a corrupted one is worse, and blocking here would stop the turn itself.
if ! have_json_parser; then
  echo "hook-session-state: no JSON parser (need jq or node) — turn state is not being reported on this machine." >&2
  echo "  install one with: $(install_hint jq)" >&2
  exit 0
fi

input=$(cat)

# Skip Task-tool subagent events: when a subagent's hooks fire, updating the parent
# session's state file would mislabel the parent as idle while Task is still running.
parent_sid=$(json_get '.parent_session_id' "$input")
[ -n "$parent_sid" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(json_get '.cwd' "$input")}"
[ -z "$PROJECT_DIR" ] && exit 0

STATE_DIR="$PROJECT_DIR/.claude/state"
STATE_FILE="$STATE_DIR/session-status.json"
mkdir -p "$STATE_DIR"

event=$(json_get '.hook_event_name' "$input")
session_id=$(json_get '.session_id' "$input")
[ -z "$session_id" ] && session_id=unknown
now=$(date +%s)
sid_json=$(json_quote "$session_id")

if [ -f "$STATE_FILE" ]; then
  state_json=$(cat "$STATE_FILE")
else
  state_json='{"session_id":"","state":"idle","last_user_prompt_ts":0,"last_tool_ts":0,"last_stop_ts":0}'
fi

case "$event" in
  UserPromptSubmit)
    patch="{\"session_id\":$sid_json,\"state\":\"running\",\"last_user_prompt_ts\":$now}"
    printf '0' > "$STATE_DIR/tool-count"
    ;;
  PreToolUse)
    patch="{\"session_id\":$sid_json,\"last_tool_ts\":$now}"
    ;;
  Stop)
    patch="{\"session_id\":$sid_json,\"state\":\"idle\",\"last_stop_ts\":$now}"
    ;;
  *)
    patch=""
    ;;
esac

if [ -n "$patch" ]; then
  # Only overwrite on a successful merge. A failed one used to leave the
  # command substitution empty and truncate the state file to zero bytes, at
  # which point every later read fell back to defaults and the session read as
  # idle while it was working.
  if merged=$(json_merge "$patch" "$state_json") && [ -n "$merged" ]; then
    printf '%s' "$merged" > "$STATE_FILE"
  else
    echo "hook-session-state: could not merge state (need jq or node); leaving $STATE_FILE alone" >&2
  fi
fi
exit 0
