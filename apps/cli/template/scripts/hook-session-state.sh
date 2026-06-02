#!/bin/bash
# Unified state hook for UserPromptSubmit / PreToolUse / Stop.
# Writes to $CLAUDE_PROJECT_DIR/.claude/state/session-status.json for the status reporter to read.
# Fully project-relative — no hardcoded agent paths.

set -u
export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

input=$(cat)

# Skip Task-tool subagent events: when a subagent's hooks fire, updating the parent
# session's state file would mislabel the parent as idle while Task is still running.
parent_sid=$(printf '%s' "$input" | jq -r '.parent_session_id // empty' 2>/dev/null)
[ -n "$parent_sid" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(printf '%s' "$input" | jq -r '.cwd // empty')}"
[ -z "$PROJECT_DIR" ] && exit 0

STATE_DIR="$PROJECT_DIR/.claude/state"
STATE_FILE="$STATE_DIR/session-status.json"
mkdir -p "$STATE_DIR"

event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"')
now=$(date +%s)

if [ -f "$STATE_FILE" ]; then
  state_json=$(cat "$STATE_FILE")
else
  state_json='{"session_id":"","state":"idle","last_user_prompt_ts":0,"last_tool_ts":0,"last_stop_ts":0}'
fi

case "$event" in
  UserPromptSubmit)
    state_json=$(printf '%s' "$state_json" | jq \
      --arg sid "$session_id" --argjson ts "$now" \
      '.session_id=$sid | .state="running" | .last_user_prompt_ts=$ts')
    printf '0' > "$STATE_DIR/tool-count"
    ;;
  PreToolUse)
    state_json=$(printf '%s' "$state_json" | jq \
      --arg sid "$session_id" --argjson ts "$now" \
      '.session_id=$sid | .last_tool_ts=$ts')
    ;;
  Stop)
    state_json=$(printf '%s' "$state_json" | jq \
      --arg sid "$session_id" --argjson ts "$now" \
      '.session_id=$sid | .state="idle" | .last_stop_ts=$ts')
    ;;
esac

printf '%s' "$state_json" > "$STATE_FILE"
exit 0
