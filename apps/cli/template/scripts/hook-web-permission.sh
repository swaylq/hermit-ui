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

# shellcheck source=./lib/json.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)/json.sh"

# This hook fails OPEN by design — exit 2 means "deny", so a hook that errors
# would block every tool the agent has. That makes a missing parser dangerous
# in a different way from the image hook: not a wedged session, but a gate that
# is simply not there while looking exactly like one that ran and approved.
# Ubuntu has no jq by default, so say it out loud, once per invocation, and
# defer.
if ! have_json_parser; then
  echo "hook-web-permission: no JSON parser (need jq or node) — the web permission gate is INACTIVE on this machine." >&2
  echo "  install one with: $(install_hint jq)" >&2
  exit 0
fi

input=$(cat)

# Full-autonomy (2026-06-02): in bypassPermissions mode claude auto-allows every
# tool, so there is no invisible TUI prompt to route to the web — defer at once.
# This is how the dashboard-chat web-permission gate is turned off fleet-wide
# without a hang risk: default / plan / acceptEdits sessions still gate normally,
# and a session reverts to gating the moment it stops running --dangerously-skip-permissions.
if [ "$(json_get '.permission_mode' "$input")" = "bypassPermissions" ]; then
  exit 0
fi

# Subagent (Task tool) events: gating them would deadlock the parent — defer.
parent_sid=$(json_get '.parent_session_id' "$input")
[ -n "$parent_sid" ] && exit 0

tool=$(json_get '.tool_name' "$input")
[ -z "$tool" ] && exit 0

# AskUserQuestion is handled by hook-block-askuserquestion.sh (deny → use
# mcp__hermit__ask); our own dashboard-routed tools never escalate.
case "$tool" in
  AskUserQuestion) exit 0 ;;
  mcp__hermit__*) exit 0 ;;
esac

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(json_get '.cwd' "$input")}"

# Covered = the tool's bare name is in permissions.allow (settings.json or the
# gitignored .local). If covered, defer — the harness allows it silently and we
# add no friction. (Scoped-only rules like Bash(git*) without a bare Bash will
# over-escalate, which is safe; narrow deliberately if you want that.)
covered() {
  [ -f "$1" ] || return 1
  json_array_has '.permissions.allow' "$tool" "$(cat "$1")"
}
if covered "$PROJECT_DIR/.claude/settings.json" || covered "$PROJECT_DIR/.claude/settings.local.json"; then
  exit 0
fi

url="${HERMIT_DASHBOARD_URL:-}"
key="${HERMIT_KEY:-}"
if [ -z "$url" ] || [ -z "$key" ]; then
  exit 0 # can't reach the dashboard → defer rather than block
fi

session_id=$(json_get '.session_id' "$input")
cwd=$(json_get '.cwd' "$input")
# json_get returns an object as compact JSON, which is what this needs to embed.
tool_input=$(json_get '.tool_input' "$input")
[ -z "$tool_input" ] && tool_input='{}'

# Assembled with quoted literals rather than a `jq -n` template: the pieces are
# already valid JSON (json_quote for the strings, compact JSON for tool_input),
# so this needs no second parser and behaves identically under either backend.
sid_json=$(json_quote "$session_id")
tool_json=$(json_quote "$tool")
cwd_json=$(json_quote "$cwd")
body="{\"claudeSessionId\":$sid_json,\"kind\":\"permission\",\"payload\":{\"tool\":$tool_json,\"input\":$tool_input,\"cwd\":$cwd_json,\"claudeSessionId\":$sid_json}}"

resp=$(curl -sS -m 15 -X POST "$url/api/sync/interaction" \
  -H 'content-type: application/json' -H "x-asst-key: $key" -d "$body" 2>/dev/null)
id=$(json_get '.id' "$resp")
if [ -z "$id" ]; then
  exit 0 # couldn't create the request → defer (don't hard-deny on an infra hiccup)
fi

# Block for the decision. Self-stop at 14200s, safely under the 14400s timeout.
deadline=$(($(date +%s) + 14200))
decision=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 2
  st=$(curl -sS -m 15 "$url/api/sync/interaction?id=$id" -H "x-asst-key: $key" 2>/dev/null)
  status=$(json_get '.status' "$st")
  [ "$status" = "pending" ] && continue
  if [ -n "$status" ]; then
    decision=$(json_get '.decision.behavior' "$st")
    break
  fi
done

if [ "$decision" = "allow" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n'
  exit 0
fi

reason="Denied by the user in the dashboard."
[ -z "$decision" ] && reason="No dashboard response within the approval window — denied for safety. Ask the user before retrying."
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$(json_quote "$reason")"
exit 0
