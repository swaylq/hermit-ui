#!/bin/bash
# hook-web-permission.sh — PreToolUse: route UNCOVERED permission prompts to the
# dashboard instead of the local TUI modal (which the web user can't see, so the
# turn hangs forever).
#
# A tool whose BARE name is in this agent's settings.json permissions.allow is
# deferred (exit 0 → claude's normal flow allows it silently — ZERO added
# friction; nothing currently-allowed changes). Anything NOT covered is
# escalated: POST an interaction (kind=permission) to the dashboard, BLOCK
# polling for the user's allow/deny, then emit the matching permissionDecision.
# Because the hook returns a decision, the TUI modal never renders.
#
# We self-deny just UNDER the hook `timeout` (settings.json: 14400s / 4h) so
# claude never time-kills us mid-wait — a killed hook falls through to the
# invisible modal, the exact hang we're removing. A stuck approval degrades to a
# clean deny instead.
#
# HERMIT_DASHBOARD_URL + HERMIT_KEY come from the tmux pane env (the gateway
# injects them via `tmux new-session -e`). If absent, the hook defers, so a
# misconfig never bricks the agent.

set -u
export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

input=$(cat)

# Full-autonomy (2026-06-02): in bypassPermissions mode claude auto-allows every
# tool, so there is no invisible TUI prompt to route to the web — defer at once.
# This is how the dashboard-chat web-permission gate is turned off fleet-wide
# without a hang risk: default / plan / acceptEdits sessions still gate normally,
# and a session reverts to gating the moment it stops running --dangerously-skip-permissions.
if [ "$(printf '%s' "$input" | jq -r '.permission_mode // empty' 2>/dev/null)" = "bypassPermissions" ]; then
  exit 0
fi

# Subagent (Task tool) events: gating them would deadlock the parent — defer.
parent_sid=$(printf '%s' "$input" | jq -r '.parent_session_id // empty' 2>/dev/null)
[ -n "$parent_sid" ] && exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ -z "$tool" ] && exit 0

# AskUserQuestion is handled by hook-block-askuserquestion.sh (deny → use
# mcp__hermit__ask); our own dashboard-routed tools never escalate.
case "$tool" in
  AskUserQuestion) exit 0 ;;
  mcp__hermit__*) exit 0 ;;
esac

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(printf '%s' "$input" | jq -r '.cwd // empty')}"

# Covered = the tool's bare name is in permissions.allow (settings.json or the
# gitignored .local). If covered, defer — the harness allows it silently and we
# add no friction. (Scoped-only rules like Bash(git*) without a bare Bash will
# over-escalate, which is safe; narrow deliberately if you want that.)
covered() {
  [ -f "$1" ] || return 1
  jq -e --arg t "$tool" '((.permissions.allow // []) | index($t)) != null' "$1" >/dev/null 2>&1
}
if covered "$PROJECT_DIR/.claude/settings.json" || covered "$PROJECT_DIR/.claude/settings.local.json"; then
  exit 0
fi

url="${HERMIT_DASHBOARD_URL:-}"
key="${HERMIT_KEY:-}"
if [ -z "$url" ] || [ -z "$key" ]; then
  exit 0 # can't reach the dashboard → defer rather than block
fi

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
tool_input=$(printf '%s' "$input" | jq -c '.tool_input // {}' 2>/dev/null)
[ -z "$tool_input" ] && tool_input='{}'

body=$(jq -nc --arg sid "$session_id" --arg tool "$tool" --argjson ti "$tool_input" --arg cwd "$cwd" \
  '{claudeSessionId:$sid, kind:"permission", payload:{tool:$tool, input:$ti, cwd:$cwd, claudeSessionId:$sid}}')

resp=$(curl -sS -m 15 -X POST "$url/api/sync/interaction" \
  -H 'content-type: application/json' -H "x-asst-key: $key" -d "$body" 2>/dev/null)
id=$(printf '%s' "$resp" | jq -r '.id // empty' 2>/dev/null)
if [ -z "$id" ]; then
  exit 0 # couldn't create the request → defer (don't hard-deny on an infra hiccup)
fi

# Block for the decision. Self-stop at 14200s, safely under the 14400s timeout.
deadline=$(($(date +%s) + 14200))
decision=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 2
  st=$(curl -sS -m 15 "$url/api/sync/interaction?id=$id" -H "x-asst-key: $key" 2>/dev/null)
  status=$(printf '%s' "$st" | jq -r '.status // empty' 2>/dev/null)
  [ "$status" = "pending" ] && continue
  if [ -n "$status" ]; then
    decision=$(printf '%s' "$st" | jq -r '.decision.behavior // empty' 2>/dev/null)
    break
  fi
done

if [ "$decision" = "allow" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n'
  exit 0
fi

reason="Denied by the user in the dashboard."
[ -z "$decision" ] && reason="No dashboard response within the approval window — denied for safety. Ask the user before retrying."
jq -nc --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
