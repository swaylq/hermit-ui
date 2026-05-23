#!/bin/bash
# Trigger a Claude Code CLI built-in command (/clear, /compact, /model, ...)
# by injecting keystrokes into the tmux session running this agent.
#
# Usage:
#   exec-cli-command.sh "<command>" [delay-seconds] [--dry-run] [--force]
#
# Examples:
#   exec-cli-command.sh "/compact"
#   exec-cli-command.sh "/model opus" 10
#   exec-cli-command.sh "/clear" 5 --dry-run

set -u
export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

# Auto-detect tmux session from agent name (folder containing scripts/).
# Convention: tmux session is "claude-<folder-basename>".
# Override by exporting TMUX_SESSION before invoking this script.
if [ -z "${TMUX_SESSION:-}" ]; then
  _SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _WS_NAME="$(basename "$(dirname "$_SCRIPT_DIR")")"
  TMUX_SESSION="claude-$_WS_NAME"
fi

DELAY=5
DRY_RUN=0
CMD=""
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    /*) CMD="$arg" ;;
    *[0-9]*) [[ "$arg" =~ ^[0-9]+$ ]] && DELAY="$arg" ;;
  esac
done

if [ -z "$CMD" ]; then
  cat <<EOF
Usage: $0 "<command>" [delay-seconds] [--dry-run] [--force]

Examples:
  $0 "/compact"        compact conversation after 5s
  $0 "/clear"          clear conversation after 5s
  $0 "/model opus" 10  switch model after 10s (arg form = one-shot)
  $0 "/help" 3 --dry-run

One-shot commands (SAFE to inject remotely):
  /clear /compact /cost /status /exit /logout /init /fast
  /model <name>    (with arg — picks model, no picker UI)
  skill commands:  /restart /cron …

Interactive commands (UNSAFE — opens modal, blocks REPL until dismissed):
  /help /config /memory /agents /mcp /permissions /bashes /hooks /ide
  /login /resume /bug /output-style /statusline /terminal-setup /vim
  /model    (no arg — picker UI)

Interactive commands are blocked by default; they'd hang the tmux REPL
and cut off Telegram replies until a human dismisses the panel at the
terminal. Pass --force if you truly want to inject one anyway.

Notes:
  - Command MUST start with '/'
  - Default 5s delay lets the current Claude turn finish before keys inject
  - Keys are sent to tmux session '$TMUX_SESSION'
EOF
  exit 1
fi

INTERACTIVE_CMDS=(
  "/help" "/config" "/memory" "/agents" "/mcp" "/permissions"
  "/bashes" "/hooks" "/ide" "/login" "/resume" "/bug"
  "/output-style" "/statusline" "/terminal-setup" "/vim"
)

CMD_ROOT="${CMD%% *}"
IS_INTERACTIVE=0
for bad in "${INTERACTIVE_CMDS[@]}"; do
  [ "$CMD_ROOT" = "$bad" ] && IS_INTERACTIVE=1 && break
done
# /model with no args opens the picker UI; /model <name> is one-shot
[ "$CMD" = "/model" ] && IS_INTERACTIVE=1

if [ "$IS_INTERACTIVE" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
  cat >&2 <<EOF
Error: '$CMD' is an interactive command — it opens a modal panel and
takes over the TUI, blocking the REPL until dismissed at the terminal.
Injecting it remotely (via tmux send-keys) will hang the session and
cut off Telegram replies.

Safe alternatives:
  /clear /compact /cost /status /exit /logout /init /fast
  /model <name>    (e.g. /model opus — with arg, no picker)

If you really need to inject this, pass --force. Otherwise run it at
the terminal directly.
EOF
  exit 4
fi

if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "Error: tmux session '$TMUX_SESSION' not found" >&2
  exit 3
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: would run in ${DELAY}s:  tmux send-keys -t $TMUX_SESSION \"$CMD\" Enter"
  exit 0
fi

(sleep "$DELAY" && tmux send-keys -t "$TMUX_SESSION" "$CMD" Enter) &
disown

echo "Scheduled: $CMD (in ${DELAY}s → tmux:$TMUX_SESSION)"
exit 0
