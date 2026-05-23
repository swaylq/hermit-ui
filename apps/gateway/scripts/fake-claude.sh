#!/usr/bin/env bash
# Stub for tmux-driver tests. Pretends to be `claude` by writing a JSONL
# transcript at ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl, emitting a
# couple of fake events, and then sleeping so the tmux pane stays alive
# until the test kills it.
#
# Usage:
#   fake-claude.sh                — generate uuid, emit canned events
#   fake-claude.sh <uuid>         — use the given uuid
#   FAKE_EVENTS_FILE=foo.jsonl    — append the lines of this file instead of canned

set -euo pipefail

UUID="${1:-$(uuidgen | tr 'A-Z' 'a-z')}"
PWD_PATH=$(pwd)
ENCODED=$(echo "$PWD_PATH" | sed 's|/|-|g')
DIR="$HOME/.claude/projects/$ENCODED"
mkdir -p "$DIR"
JSONL="$DIR/$UUID.jsonl"

# Mark startup so getClaudeSessionUuid sees a non-empty file.
echo '{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"'"$UUID"'"}' >> "$JSONL"

# Emit events. Either from FAKE_EVENTS_FILE or the default canned pair.
if [[ -n "${FAKE_EVENTS_FILE:-}" && -f "$FAKE_EVENTS_FILE" ]]; then
  cat "$FAKE_EVENTS_FILE" >> "$JSONL"
else
  echo '{"type":"user","uuid":"u-1-'"$UUID"'","message":{"role":"user","content":"hello from test"},"sessionId":"'"$UUID"'"}' >> "$JSONL"
  sleep 0.2
  echo '{"type":"assistant","uuid":"a-1-'"$UUID"'","message":{"role":"assistant","content":[{"type":"text","text":"hi back from fake-claude"}]},"sessionId":"'"$UUID"'"}' >> "$JSONL"
fi

# Stay alive so tmux pane doesn't exit. Test kills us via tmux kill-session.
sleep 999
