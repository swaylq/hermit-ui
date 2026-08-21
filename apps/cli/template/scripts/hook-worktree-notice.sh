#!/bin/bash
# hook-worktree-notice.sh — SessionStart notice about sibling sessions.
#
# Every dashboard session of an agent runs in the SAME directory, so they share every
# git repo in it: a branch switch in one moves the working tree under another, and
# simultaneous edits overwrite. The worktree skill fixes that, but a skill only gets
# read when the agent thinks to look for it — and "another session exists" is
# invisible from inside a session.
#
# So state it once, at the start, and only when it's true. Silent for a sole session:
# no noise, no tokens, nothing to ignore. Deliberately NOT a PreToolUse gate — this
# never blocks a tool call, it just makes the situation visible.
#
# Liveness is `wt.sh siblings` — the skill's own primitive — so the notice and the
# skill can never disagree about who is live. Until 2026-08-21 this script counted
# tmux panes itself, and went permanently silent the moment the claude-sdk backend
# replaced the pane with a plain gateway subprocess: 10 concurrent sessions, zero
# notices. Nothing here may assume tmux.
#
# Design: hermit-ui/docs/worktree-skill-design.md

set -u
export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

# Drain stdin (the hook payload) so the caller never blocks on a full pipe.
payload=$(cat 2>/dev/null || true)

dir=${CLAUDE_PROJECT_DIR:-}
[ -n "$dir" ] || dir=$(printf '%s' "$payload" \
  | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$dir" ] || dir=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P)
[ -n "$dir" ] || exit 0

wt="$dir/.claude/skills/worktree/wt.sh"
[ -f "$wt" ] || exit 0

sibs=$(cd "$dir" 2>/dev/null && bash "$wt" siblings 2>/dev/null | grep . ) || exit 0
count=$(printf '%s\n' "$sibs" | grep -c . || true)
[ "${count:-0}" -gt 0 ] || exit 0

names=$(printf '%s\n' "$sibs" | tr '\n' ' ' | sed 's/ *$//')

cat <<EOF
[worktree] $count other live session(s) of this agent share this directory — $names

They share every git repo here: a branch switch or an edit in one lands in the others'
working tree. Before editing files in a git repo, use the \`worktree\` skill (it checks
whether isolation is actually needed and sets it up). Read-only work needs nothing.
EOF
