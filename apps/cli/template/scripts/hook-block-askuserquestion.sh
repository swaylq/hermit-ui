#!/bin/bash
# hook-block-askuserquestion.sh — PreToolUse block for AskUserQuestion.
#
# AskUserQuestion is Claude Code's built-in tool for prompting the user to pick
# from a set of options. It renders a TUI modal directly to stdin/stdout — in
# the hermit-agent headless tmux + web dashboard setup, the user never sees it
# and the turn hangs forever waiting on stdin.
#
# Block the call and redirect the agent to mcp__hermit__ask, which renders the
# same multiple-choice question as CLICKABLE options in the dashboard, blocks
# until the user picks, and returns their choice as the tool result. The reason
# text reaches the model mid-turn.

exec /usr/bin/env python3 -c '
import json, sys

try:
    event = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    sys.exit(0)

if event.get("tool_name") != "AskUserQuestion":
    sys.exit(0)

reason = (
    "AskUserQuestion is disabled in this hermit (headless tmux + web dashboard). "
    "Its TUI modal renders to the local pane only — the user is on the dashboard and never sees it, "
    "so the turn would hang forever waiting on stdin. "
    "Instead call mcp__hermit__ask with {question, options:[{label, description?}], multiSelect?} — "
    "it shows clickable option buttons in the chat, blocks until the user picks, "
    "and returns their choice as the tool result so you can continue this same turn."
)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }
}))
sys.exit(0)
'
