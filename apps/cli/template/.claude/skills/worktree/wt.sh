#!/usr/bin/env bash
# wt.sh — git worktree isolation for one agent's concurrent dashboard sessions.
#
# Every session of an agent is a tmux pane in the SAME directory, so they share every
# repo in it. This gives each session its own worktree when — and only when — another
# session is live, and lands the work without anybody ever checking out the base branch.
#
# Subcommands (all idempotent):
#   check <repo>   is isolation needed here, and why
#   enter <repo>   create/reuse this session's worktree, print its path
#   land  <wt>     rebase onto base, push HEAD:base, remove the worktree
#   sweep <repo>   report/remove worktrees whose session is gone
#
# Session identity comes from tmux (`#S` = hermit-<id>). HERMIT_WT_SELF and
# HERMIT_WT_SESSIONS override it, which is what makes the logic testable without tmux:
#   HERMIT_WT_SELF=hermit-aaaa HERMIT_WT_SESSIONS='hermit-aaaa:/dir hermit-bbbb:/dir'
#
# Design: hermit-ui/docs/worktree-skill-design.md
set -uo pipefail

WT_ROOT="${HERMIT_WT_ROOT:-$HOME/.hermit/worktrees}"

die() { echo "wt: $*" >&2; exit 1; }

# Resolve WT_ROOT to its PHYSICAL path up front. `git worktree list` reports resolved
# paths, so an unresolved root silently breaks every comparison against it — on macOS
# /var is a symlink to /private/var, which made `sweep` match none of its own
# worktrees and `enter` disagree with itself about where it just put one.
mkdir -p "$WT_ROOT" 2>/dev/null || die "cannot create $WT_ROOT"
WT_ROOT=$(cd "$WT_ROOT" && pwd -P)

# ── session identity ─────────────────────────────────────────────────────────

# This session's tmux name (hermit-pv2096yok0i0), or empty when not under tmux.
self_session() {
  if [ -n "${HERMIT_WT_SELF:-}" ]; then echo "$HERMIT_WT_SELF"; return; fi
  tmux display-message -p '#S' 2>/dev/null || true
}

# The short id used for paths and branch names.
self_id() {
  local s; s=$(self_session)
  [ -n "$s" ] || die "no tmux session — can't tell which session this is"
  echo "${s#hermit-}"
}

# "<session>:<agent dir>" per live dashboard session. Injectable for tests.
live_sessions() {
  if [ -n "${HERMIT_WT_SESSIONS:-}" ]; then
    printf '%s\n' $HERMIT_WT_SESSIONS
    return
  fi
  local s p
  for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep '^hermit-' || true); do
    p=$(tmux display-message -p -t "$s" '#{pane_current_path}' 2>/dev/null) || continue
    echo "$s:$p"
  done
}

# Sibling sessions: same agent directory, not me. Prints their names.
siblings() {
  local me mine rest
  me=$(self_session)
  mine=$(live_sessions | awk -F: -v me="$me" '$1==me {print $2; exit}')
  # Not in the list (hook running before registration, or a test): fall back to cwd.
  [ -n "$mine" ] || mine=$PWD
  live_sessions | while IFS=: read -r name dir; do
    [ "$name" = "$me" ] && continue
    [ "$dir" = "$mine" ] && echo "$name"
  done
}

# ── repo helpers ─────────────────────────────────────────────────────────────

repo_root() { git -C "$1" rev-parse --show-toplevel 2>/dev/null; }

# The branch we integrate into: origin/HEAD's target, else main/master if present,
# else whatever is checked out. Printed as a bare name (no origin/ prefix).
base_branch() {
  local r=$1 b
  b=$(git -C "$r" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -n "$b" ]; then echo "${b#origin/}"; return; fi
  for b in main master; do
    git -C "$r" show-ref --verify --quiet "refs/heads/$b" && { echo "$b"; return; }
  done
  git -C "$r" rev-parse --abbrev-ref HEAD 2>/dev/null
}

has_remote() { git -C "$1" remote | grep -q .; }

# Am I inside a linked worktree already (rather than the main checkout)?
in_worktree() {
  local r=$1
  [ "$(git -C "$r" rev-parse --git-dir)" != "$(git -C "$r" rev-parse --git-common-dir)" ]
}

wt_path() { echo "$WT_ROOT/$(basename "$1")/$(self_id)"; }
wt_branch() { echo "wt/$(self_id)"; }

# ── check ────────────────────────────────────────────────────────────────────

cmd_check() {
  local repo r sibs n
  repo=${1:-$PWD}
  r=$(repo_root "$repo") || die "not a git repo: $repo"
  [ -n "$r" ] || die "not a git repo: $repo"

  if in_worktree "$r"; then
    echo "isolated=already  path=$r"
    echo "This IS a worktree. Keep working here; run 'land' when the work is done."
    return 0
  fi

  sibs=$(siblings)
  n=$(printf '%s' "$sibs" | grep -c . || true)
  if [ "$n" -eq 0 ]; then
    echo "isolated=no  reason=sole-session  path=$r"
    echo "No other live session of this agent. Work in the main checkout."
    return 0
  fi
  echo "isolated=needed  siblings=$n  path=$r"
  echo "$sibs" | sed 's/^/  sibling: /'
  echo "Run: $0 enter $r"
}

# ── enter ────────────────────────────────────────────────────────────────────

cmd_enter() {
  local repo r wt br base
  repo=${1:-$PWD}
  r=$(repo_root "$repo") || die "not a git repo: $repo"
  [ -n "$r" ] || die "not a git repo: $repo"
  in_worktree "$r" && { echo "$r"; return 0; }   # already isolated

  wt=$(wt_path "$r"); br=$(wt_branch)

  # Idempotent: an existing worktree for this session is reused as-is. Never
  # recreated — it may hold uncommitted work from before a restart.
  if [ -d "$wt" ]; then echo "$wt"; return 0; fi

  base=$(base_branch "$r")
  [ -n "$base" ] || die "can't determine the base branch of $r"
  mkdir -p "$(dirname "$wt")" || die "mkdir failed: $(dirname "$wt")"

  local start=$base
  if has_remote "$r"; then
    git -C "$r" fetch --quiet origin "$base" 2>/dev/null && start="origin/$base"
  fi

  # A branch left behind by a previous worktree of this same session: reuse it
  # rather than fail, so a restarted session picks its work back up.
  if git -C "$r" show-ref --verify --quiet "refs/heads/$br"; then
    git -C "$r" worktree add "$wt" "$br" >/dev/null || die "worktree add failed"
  else
    git -C "$r" worktree add -b "$br" "$wt" "$start" >/dev/null || die "worktree add failed"
  fi
  echo "$wt"
}

# ── land ─────────────────────────────────────────────────────────────────────

cmd_land() {
  local wt r base br ahead
  wt=${1:-$PWD}
  r=$(repo_root "$wt") || die "not a git repo: $wt"
  in_worktree "$r" || die "not a worktree: $r (nothing to land)"

  [ -z "$(git -C "$r" status --porcelain)" ] || die "uncommitted changes in $r — commit or stash first"

  br=$(git -C "$r" rev-parse --abbrev-ref HEAD)
  base=$(base_branch "$r")
  [ "$br" != "$base" ] || die "already on $base — this worktree has no branch of its own"

  if has_remote "$r"; then
    git -C "$r" fetch --quiet origin "$base" || die "fetch failed"
    if ! git -C "$r" rebase "origin/$base" >/dev/null 2>&1; then
      git -C "$r" rebase --abort >/dev/null 2>&1
      die "rebase onto origin/$base conflicts — resolve it here ($r), then re-run land"
    fi
    ahead=$(git -C "$r" rev-list --count "origin/$base..HEAD")
    [ "$ahead" -gt 0 ] || { echo "nothing to land (no commits ahead of origin/$base)"; }
    if [ "$ahead" -gt 0 ]; then
      git -C "$r" push --quiet origin "HEAD:$base" || die "push to $base failed — someone moved it; re-run land"
      echo "landed $ahead commit(s) on $base"
    fi
  else
    # No remote: fast-forward the local base ref without checking it out.
    ahead=$(git -C "$r" rev-list --count "$base..HEAD")
    if [ "$ahead" -gt 0 ]; then
      git -C "$r" update-ref "refs/heads/$base" HEAD || die "update-ref failed"
      echo "fast-forwarded local $base by $ahead commit(s)"
    fi
  fi

  local main_root
  main_root=$(git -C "$r" rev-parse --path-format=absolute --git-common-dir)
  main_root=$(dirname "$main_root")
  git -C "$main_root" worktree remove "$r" || die "worktree remove failed (still in it? cd out first)"
  git -C "$main_root" branch -D "$br" >/dev/null 2>&1
  echo "removed worktree $r"
  echo "NOTE: the main checkout still shows $base as behind until it pulls — that is expected."
}

# ── sweep ────────────────────────────────────────────────────────────────────

cmd_sweep() {
  local repo r base ref live p id dirty unmerged removed=0 kept=0
  repo=${1:-$PWD}
  r=$(repo_root "$repo") || die "not a git repo: $repo"
  base=$(base_branch "$r")
  # Compare against the REMOTE base, not the local ref. The local one is stale by
  # design — landing pushes HEAD straight to origin and never checks base out — so
  # measuring against it marks fully-landed worktrees as unmerged and keeps them
  # forever. Fetch first so "merged" reflects what's actually on the remote; offline
  # falls back to whatever ref we already have.
  ref=$base
  if has_remote "$r"; then
    git -C "$r" fetch --quiet origin "$base" 2>/dev/null
    git -C "$r" rev-parse --verify --quiet "origin/$base" >/dev/null && ref="origin/$base"
  fi
  live=$(live_sessions | cut -d: -f1 | sed 's/^hermit-//')

  git -C "$r" worktree prune

  while read -r p; do
    case "$p" in "$WT_ROOT"/*) ;; *) continue ;; esac   # only ours
    id=$(basename "$p")
    printf '%s\n' "$live" | grep -qx "$id" && continue  # session still alive
    dirty=$(git -C "$p" status --porcelain 2>/dev/null)
    unmerged=$(git -C "$p" rev-list --count "$ref..HEAD" 2>/dev/null || echo 0)
    if [ -n "$dirty" ] || [ "${unmerged:-0}" -gt 0 ]; then
      echo "KEEP  $p  (session gone; ${unmerged:-0} unmerged commit(s)$([ -n "$dirty" ] && echo ', uncommitted changes'))"
      kept=$((kept + 1))
      continue
    fi
    git -C "$r" worktree remove "$p" >/dev/null 2>&1 && {
      git -C "$r" branch -D "wt/$id" >/dev/null 2>&1
      echo "removed $p"
      removed=$((removed + 1))
    }
  done < <(git -C "$r" worktree list --porcelain | awk '/^worktree /{print $2}')

  echo "sweep: removed $removed, kept $kept"
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  enter) shift; cmd_enter "$@" ;;
  land)  shift; cmd_land  "$@" ;;
  sweep) shift; cmd_sweep "$@" ;;
  *) die "usage: wt.sh {check|enter|land|sweep} [path]" ;;
esac
