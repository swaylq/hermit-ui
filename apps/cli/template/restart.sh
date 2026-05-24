#!/bin/bash
# Restart this hermit agent's main tmux pane.
#
# Usage: ./restart.sh <old_pid>
#
# Uses `tmux respawn-pane` (not send-keys) so a still-alive REPL in the pane
# doesn't interpret the launch command as a chat message. The current turn is
# given ~3s to finish flushing before the old pid is SIGTERMed.

set -u

OLD_PID="${1:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_NAME="$(basename "$DIR")"
SESSION="claude-$AGENT_NAME"
LOG="$DIR/restart.log"

CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "[$(date)] ERROR: claude CLI not found on PATH" >> "$LOG"
  exit 1
fi

CMD="cd $DIR && $CLAUDE_BIN --dangerously-skip-permissions"

echo "[$(date)] Restart initiated, old PID=$OLD_PID, bin=$CLAUDE_BIN" >> "$LOG"

# Give the current turn a moment to flush.
sleep 3

if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  kill "$OLD_PID"
  for i in $(seq 1 10); do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID"
  echo "[$(date)] Old process killed" >> "$LOG"
fi

sleep 2

start_pane() {
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    tmux respawn-pane -t "=$SESSION:" -k "$CMD"
    echo "[$(date)] Respawned pane in existing session" >> "$LOG"
  else
    tmux new-session -d -s "$SESSION" -x 200 -y 50 "$CMD"
    echo "[$(date)] Created new session" >> "$LOG"
  fi
}

resolve_pid() {
  local pane_pid
  pane_pid=$(tmux display -p -t "=$SESSION:" '#{pane_pid}' 2>/dev/null)
  [ -z "$pane_pid" ] && return 1
  if ps -p "$pane_pid" -o command= 2>/dev/null | grep -q "$(basename "$CLAUDE_BIN")"; then
    echo "$pane_pid"
  else
    pgrep -P "$pane_pid" -n -f "$(basename "$CLAUDE_BIN")" 2>/dev/null
  fi
}

start_pane
sleep 4
NEW_PID=$(resolve_pid)

if [ -n "$NEW_PID" ]; then
  echo "$NEW_PID" > "$DIR/agent.pid"
  echo "[$(date)] New PID=$NEW_PID" >> "$LOG"
else
  echo "[$(date)] WARNING: Could not resolve new claude PID via tmux pane" >> "$LOG"
fi
