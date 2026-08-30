#!/usr/bin/env bash
# gitlab-init.sh — give a local-only repo a home on GitLab so it can be worktree'd.
#
# Two states stop `wt.sh` cold, and both are normal for a project someone started with
# `git init` and never pushed:
#
#   no commits   `git worktree add … HEAD` dies with "fatal: invalid reference: HEAD".
#   no remote    `land` can only move the local base ref, which leaves the main
#                checkout's FILES untouched — everyone else keeps reading stale code.
#
# This script fixes the second and refuses (loudly) on the first, because deciding what
# to track is a judgement call: a worktree is a full checkout, so every session pays
# for every byte you commit. One repo here was 406MB, of which 344MB was source art
# nobody needed in git.
#
# Usage:  gitlab-init.sh <repo-dir> [project-name]
#
# Idempotent: an existing GitLab project is reused, an existing origin is left alone.
set -euo pipefail

HOST=https://git.daguchuangyi.com
NS=swaylq                       # sway's personal namespace on that GitLab

die() { echo "gitlab-init: $*" >&2; exit 1; }

repo=${1:?usage: gitlab-init.sh <repo-dir> [project-name]}
r=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || die "not a git repo: $repo"
name=${2:-$(basename "$r")}

command -v secret >/dev/null || die "the 'secret' CLI is not on PATH — GITLAB_TOKEN lives there"

# ── 1. commits ───────────────────────────────────────────────────────────────
if ! git -C "$r" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
  echo "This repo has no commits yet. Make the baseline commit yourself — what you"
  echo "track is a judgement call, and every session's worktree is a full copy of it."
  echo
  echo "The 5 biggest files git would take right now:"
  git -C "$r" status --porcelain --untracked-files=all \
    | sed 's/^...//' \
    | while read -r f; do [ -f "$r/$f" ] && echo "$(stat -f%z "$r/$f" 2>/dev/null || stat -c%s "$r/$f") $f"; done \
    | sort -rn | head -5 \
    | awk '{ printf "  %6.1f MB  %s\n", $1/1048576, $2 }'
  echo
  echo "Then:  git -C $r add -A && git -C $r commit -m 'baseline'"
  echo "       $0 $r"
  exit 1
fi

# ── 2. credentials ───────────────────────────────────────────────────────────
# `wt.sh land` runs a bare `git fetch`/`git push`, so the token cannot live in this
# script — it has to be something plain git finds on its own. A machine-wide helper
# reads it out of the encrypted store per call: never in a config file, a remote URL
# or an argv.
HELPER=$HOME/.claude/bin/git-credential-gitlab-secret
if [ ! -x "$HELPER" ]; then
  mkdir -p "$(dirname "$HELPER")"
  cat > "$HELPER" <<'SH'
#!/bin/sh
[ "$1" = get ] || exit 0
echo username=oauth2
exec secret exec GITLAB_TOKEN -- sh -c 'echo "password=$GITLAB_TOKEN"'
SH
  chmod +x "$HELPER"
  echo "installed git credential helper $HELPER"
fi
git config --global "credential.$HOST.helper" "$HELPER"

# ── 3. the GitLab project ────────────────────────────────────────────────────
# The token goes to curl through a -K config on stdin, never on the command line —
# argv is world-readable via ps.
api() {
  local method=$1 path=$2
  secret exec GITLAB_TOKEN -- sh -c '
    printf "header = \"PRIVATE-TOKEN: %s\"\n" "$GITLAB_TOKEN" |
    curl -sS -K - --max-time 30 -X "$1" "$2"' _ "$method" "$HOST/api/v4/$path"
}

encoded=$(printf '%s/%s' "$NS" "$name" | sed 's|/|%2F|g')
if api GET "projects/$encoded" | grep -q '"ssh_url_to_repo"'; then
  echo "project $NS/$name already exists on GitLab — reusing it"
else
  api POST "projects?name=$name&path=$name&visibility=private" | grep -q '"ssh_url_to_repo"' \
    || die "could not create $NS/$name on GitLab"
  echo "created $HOST/$NS/$name (private)"
fi

# ── 4. remote + first push ───────────────────────────────────────────────────
url="$HOST/$NS/$name.git"
if git -C "$r" remote | grep -qx origin; then
  echo "origin already set to $(git -C "$r" remote get-url origin) — leaving it alone"
else
  git -C "$r" remote add origin "$url"
  echo "origin -> $url"
fi

base=$(git -C "$r" rev-parse --abbrev-ref HEAD)
git -C "$r" push -u origin "$base"

git -C "$r" remote set-head origin "$base" >/dev/null 2>&1 || true
echo "pushed $base — 'wt.sh enter' works now, and 'wt.sh land' has somewhere to land"
echo
echo "Remember the third step at the end of every round: after 'wt.sh land',"
echo "run  git -C $r pull --ff-only  — land only moves the repo, not these files."
