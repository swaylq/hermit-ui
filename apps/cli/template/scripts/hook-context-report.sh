#!/bin/bash
# Stop hook: report context size to Telegram when crossing tier thresholds.
# Reads transcript_path from stdin JSON, parses last assistant usage, sums tokens.
# Notifies only on tier upgrade (100k/200k/400k/600k/800k/950k).

set -u
export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

TIERS=(100000 200000 400000 600000 800000 950000)

input=$(cat)

# Skip subagent Stop: would misread parent's context tier.
parent_sid=$(printf '%s' "$input" | jq -r '.parent_session_id // empty' 2>/dev/null)
[ -n "$parent_sid" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(printf '%s' "$input" | jq -r '.cwd // empty')}"
[ -z "$PROJECT_DIR" ] && exit 0
AGENT_NAME=$(basename "$PROJECT_DIR")

STATE_DIR="$PROJECT_DIR/.claude/state"
mkdir -p "$STATE_DIR"

transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"')

[ -z "$transcript_path" ] || [ ! -f "$transcript_path" ] && exit 0

# Cap: skip tier check on pathologically large transcripts. A 20h+ session can
# grow the jsonl past 100MB; grep + tail on that while the file is actively
# appended has occasionally held Stop phase past the UI's patience.
# Missing a tier notify once is fine — next Stop will re-check.
MAX_TRANSCRIPT_BYTES=$((50 * 1024 * 1024))
size=$(stat -f %z "$transcript_path" 2>/dev/null)
[ -n "$size" ] && [ "$size" -gt "$MAX_TRANSCRIPT_BYTES" ] && exit 0

# Hard runtime cap on the grep+tail+jq pipeline — 3s is plenty for a well-formed
# jsonl under 50MB; a bail-out is always safer than a hung Stop hook.
WITH_TIMEOUT="$(dirname "$0")/with-timeout.sh"
if [ -x "$WITH_TIMEOUT" ]; then
  usage=$("$WITH_TIMEOUT" 3 sh -c \
    "grep '\"type\":\"assistant\"' \"$transcript_path\" | tail -1 | \
     jq -r '.message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' 2>/dev/null" 2>/dev/null)
else
  usage=$(grep '"type":"assistant"' "$transcript_path" | tail -1 | \
    jq -r '.message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' 2>/dev/null)
fi

[ -z "$usage" ] || ! [[ "$usage" =~ ^[0-9]+$ ]] && exit 0

current_tier=0
for t in "${TIERS[@]}"; do
  [ "$usage" -ge "$t" ] && current_tier=$t
done

state_file="$STATE_DIR/ctx-tier-$session_id"
last_tier=0
[ -f "$state_file" ] && last_tier=$(cat "$state_file")

if [ "$current_tier" -gt "$last_tier" ]; then
  echo "$current_tier" > "$state_file"

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

  human=$(awk -v n="$usage" 'BEGIN{ if(n>=1000000) printf "%.1fM", n/1000000; else printf "%dk", n/1000 }')
  msg="📊 ${AGENT_NAME} ctx ${human}"

  curl -sS -m 10 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1
fi

exit 0
