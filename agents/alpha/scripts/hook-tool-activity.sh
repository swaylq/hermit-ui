#!/bin/bash
# PreToolUse hook: track tool count per turn, push Telegram on 1st and every 5th tool.
# Count is reset by hook-session-state.sh on UserPromptSubmit.
# Reads chat_id + bot token from settings.local.json env or env vars.

set -u
export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

input=$(cat)

# Skip subagent events — parent's tool count is the only count that matters.
parent_sid=$(printf '%s' "$input" | jq -r '.parent_session_id // empty' 2>/dev/null)
[ -n "$parent_sid" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(printf '%s' "$input" | jq -r '.cwd // empty')}"
[ -z "$PROJECT_DIR" ] && exit 0
AGENT_NAME=$(basename "$PROJECT_DIR")

COUNT_FILE="$PROJECT_DIR/.claude/state/tool-count"
mkdir -p "$(dirname "$COUNT_FILE")"

count=0
[ -f "$COUNT_FILE" ] && count=$(cat "$COUNT_FILE" 2>/dev/null)
[[ "$count" =~ ^[0-9]+$ ]] || count=0
count=$((count + 1))
printf '%s' "$count" > "$COUNT_FILE"

# Push on 1st call, then every 5th.
if [ "$count" -eq 1 ] || [ $((count % 5)) -eq 0 ]; then
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    token="$TELEGRAM_BOT_TOKEN"
  else
    token=$(jq -r '.env.TELEGRAM_BOT_TOKEN // empty' "$PROJECT_DIR/.claude/settings.local.json" 2>/dev/null)
  fi
  [ -z "$token" ] && exit 0

  if [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    chat_id="$TELEGRAM_CHAT_ID"
  else
    chat_id=$(jq -r '.env.TELEGRAM_CHAT_ID // empty' "$PROJECT_DIR/.claude/settings.local.json" 2>/dev/null)
  fi
  [ -z "$chat_id" ] && exit 0

  msg="🔨 ${AGENT_NAME} · ${count} tools"
  (curl -sS -m 5 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1 &) >/dev/null 2>&1
fi

exit 0
