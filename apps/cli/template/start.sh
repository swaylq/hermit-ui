#!/bin/bash
# Start this hermit agent in a detached tmux session.
#
# Usage:
#   ./start.sh            launch if not already running
#   ./start.sh --attach   launch + attach to the pane (Ctrl-b d to detach)
#   ./start.sh --status   print whether the session is running
#
# Hermit-ui notes:
# - This launches the agent's "main" session — useful for direct terminal
#   access while debugging. The dashboard's chat panes are spawned separately
#   by the gateway under tmux session names `hermit-<chatSessionId>`.
# - claude binary is auto-detected on PATH (no compile-time substitution).

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_NAME="$(basename "$DIR")"
SESSION="claude-$AGENT_NAME"

if ! command -v tmux >/dev/null 2>&1; then
  echo "Error: tmux not found. Install via 'brew install tmux' (mac) or your package manager." >&2
  exit 1
fi

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "Error: claude CLI not found on PATH. Install from https://claude.com/claude-code." >&2
  exit 1
fi

CMD="cd $DIR && $CLAUDE_BIN --dangerously-skip-permissions"

cmd_status() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    pane_pid=$(tmux display -p -t "$SESSION" '#{pane_pid}' 2>/dev/null)
    echo "tmux session '$SESSION' is up (pane PID: $pane_pid)."
    [ -f "$DIR/agent.pid" ] && echo "agent.pid: $(cat "$DIR/agent.pid")"
  else
    echo "tmux session '$SESSION' is not running."
  fi
}

cmd_start() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Already running (tmux session: $SESSION). Attach: tmux attach -t $SESSION. Restart: ./restart.sh \$(cat agent.pid)."
    return 0
  fi

  tmux new-session -d -s "$SESSION" -x 200 -y 50 "$CMD"
  sleep 4

  pane_pid=$(tmux display -p -t "$SESSION" '#{pane_pid}' 2>/dev/null)
  new_pid=""
  if [ -n "$pane_pid" ]; then
    if ps -p "$pane_pid" -o command= 2>/dev/null | grep -q "$(basename "$CLAUDE_BIN")"; then
      new_pid="$pane_pid"
    else
      new_pid=$(pgrep -P "$pane_pid" -n -f "$(basename "$CLAUDE_BIN")" 2>/dev/null)
    fi
  fi
  [ -n "$new_pid" ] && echo "$new_pid" > "$DIR/agent.pid"

  echo "Started hermit agent '$AGENT_NAME'."
  echo "  tmux session: $SESSION"
  [ -n "$new_pid" ] && echo "  agent.pid:    $new_pid"
  echo ""
  echo "Next steps:"
  echo "  - Send a message via the hermit-ui dashboard (configured at HERMIT_DASHBOARD_URL)."
  echo "  - Or attach directly: tmux attach -t $SESSION  (detach: Ctrl-b d)."
  echo "  - Restart: ./restart.sh \$(cat agent.pid)  |  Stop: tmux kill-session -t $SESSION"
}

case "${1:-start}" in
  --attach) cmd_start; tmux attach -t "$SESSION" ;;
  --status) cmd_status ;;
  start|"") cmd_start ;;
  *)        echo "Usage: ./start.sh [--attach|--status]" >&2; exit 1 ;;
esac
