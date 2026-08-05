#!/bin/bash
# hook-worktree-notice.sh — SessionStart notice about sibling sessions.
#
# Every dashboard session of an agent is a tmux pane in the SAME directory, so they
# share every git repo in it: a branch switch in one moves the working tree under
# another, and simultaneous edits overwrite. The worktree skill fixes that, but a skill
# only gets read when the agent thinks to look for it — and "another session exists" is
# invisible from inside a session.
#
# So state it once, at the start, and only when it's true. Silent for a sole session:
# no noise, no tokens, nothing to ignore. Deliberately NOT a PreToolUse gate — this
# never blocks a tool call, it just makes the situation visible.
#
# Design: hermit-ui/docs/worktree-skill-design.md

# Not under tmux (a -p run, a local shell) — nothing to say.
[ -n "$TMUX" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0

me=$(tmux display-message -p '#S' 2>/dev/null) || exit 0
case "$me" in hermit-*) ;; *) exit 0 ;; esac
mine=$(tmux display-message -p '#{pane_current_path}' 2>/dev/null) || exit 0

siblings=""
count=0
for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep '^hermit-'); do
    [ "$s" = "$me" ] && continue
    p=$(tmux display-message -p -t "$s" '#{pane_current_path}' 2>/dev/null) || continue
    [ "$p" = "$mine" ] || continue
    siblings="$siblings $s"
    count=$((count + 1))
done

[ "$count" -gt 0 ] || exit 0

cat <<EOF
[worktree] $count other live session(s) of this agent share this directory —$siblings

They share every git repo here: a branch switch or an edit in one lands in the others'
working tree. Before editing files in a git repo, use the \`worktree\` skill (it checks
whether isolation is actually needed and sets it up). Read-only work needs nothing.
EOF
