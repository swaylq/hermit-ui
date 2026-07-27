#!/usr/bin/env bash
# fake-claude-e2e.sh — stands in for `claude` in an E2E of the REAL tmux-driver.
# Mimics the parts the gateway actually depends on:
#   • argv shape:   … --session-id <uuid> …   (paneClaudeSessionId reads this)
#   • transcript:   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
#   • composer:     a "❯ " prompt line so composerStatus()/waitForReplReady work
#   • work marker:  prints a Claude-Code-style spinner line on demand
# Control lines it understands on stdin: EMIT, WORKMARKER, IDLE
set -u

UUID=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ]; then UUID="$a"; fi
  prev="$a"
done
[ -n "$UUID" ] || UUID="00000000-0000-0000-0000-000000000000"

ENCODED=$(pwd | sed 's|/|-|g')
DIR="$HOME/.claude/projects/$ENCODED"
mkdir -p "$DIR"
JSONL="$DIR/$UUID.jsonl"
RECV="$(pwd)/received.txt"
: > "$RECV"

emit() { printf '%s\n' "$1" >> "$JSONL"; }
prompt() { printf '\342\235\257 '; }   # "❯ " — raw UTF-8 bytes, locale-independent

emit "{\"type\":\"permission-mode\",\"permissionMode\":\"bypassPermissions\",\"sessionId\":\"$UUID\"}"
emit "{\"type\":\"user\",\"uuid\":\"u-1-$UUID\",\"message\":{\"role\":\"user\",\"content\":\"boot\"},\"sessionId\":\"$UUID\"}"

echo "fake-claude ready (session $UUID)"
prompt

n=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$RECV"
  case "$line" in
    *EMIT*)
      n=$((n + 1))
      emit "{\"type\":\"assistant\",\"uuid\":\"a-$n-$UUID\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"live event $n\"}]},\"sessionId\":\"$UUID\"}"
      echo "(emitted $n)"
      ;;
    *WORKMARKER*)
      # Exactly the shape pane.ts's WORK_MARKER_RE looks for.
      printf '\342\234\266 Considering\342\200\246 (6m 44s \302\267 thinking)\n'
      echo '  · esc to interrupt'
      ;;
    *IDLE*)
      printf '\342\234\273 Cooked for 4m 57s\n'
      echo '  ? for shortcuts'
      ;;
  esac
  prompt
done

sleep 999
