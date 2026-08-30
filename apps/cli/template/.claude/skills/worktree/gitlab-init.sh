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
  # -c core.quotepath=false: without it git escapes non-ASCII paths ("\346\210\230..."),
  # the [ -f ] probe below can't find them, and exactly the files this warning exists
  # for — big Chinese-named art — vanish from the list.
  git -C "$r" -c core.quotepath=false status --porcelain --untracked-files=all \
    | sed 's/^...//' \
    | while read -r f; do [ -f "$r/$f" ] && echo "$(stat -f%z "$r/$f" 2>/dev/null || stat -c%s "$r/$f") $f"; done \
    | sort -rn | head -5 \
    | awk '{ sz=$1; $1=""; sub(/^ /,""); printf "  %6.1f MB  %s\n", sz/1048576, $0 }'
  echo
  echo "Then:  git -C $r add -A && git -C $r commit -m 'baseline'"
  echo "       $0 $r"
  exit 1
fi

# ── 2. the GitLab project ────────────────────────────────────────────────────
# The token goes to curl through a -K config on stdin, never on the command line —
# argv is world-readable via ps.
api() {
  local method=$1 path=$2
  secret exec GITLAB_TOKEN -- sh -c '
    printf "header = \"PRIVATE-TOKEN: %s\"\n" "$GITLAB_TOKEN" |
    curl -sS -K - --max-time 30 -X "$1" "$2"' _ "$method" "$HOST/api/v4/$path"
}

# The namespace is passed explicitly. Creating without namespace_id lands the project
# wherever the token's owner defaults to — right with sway's token, wrong the moment a
# store on another machine holds a different one, and the existence check below looks
# under $NS regardless. The two halves have to agree.
ns_id=$(api GET "namespaces/$NS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])' 2>/dev/null) \
  || die "no namespace '$NS' on $HOST for this token — check GITLAB_TOKEN in the secret store"

encoded=$(printf '%s/%s' "$NS" "$name" | sed 's|/|%2F|g')
if api GET "projects/$encoded" | grep -q '"ssh_url_to_repo"'; then
  echo "project $NS/$name already exists on GitLab — reusing it"
else
  api POST "projects?name=$name&path=$name&namespace_id=$ns_id&visibility=private" \
    | grep -q '"ssh_url_to_repo"' || die "could not create $NS/$name on GitLab"
  echo "created $HOST/$NS/$name"
fi

# Say out loud where it went and that it is closed. A repo that silently landed in the
# wrong namespace, or public, is not something you notice by reading a git remote.
api GET "projects/$encoded" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["path_with_namespace"], d["visibility"])' \
  | { read -r where vis
      [ "$where" = "$NS/$name" ] || die "project landed in $where, expected $NS/$name"
      [ "$vis" = private ] || die "project is $vis, expected private"
      echo "confirmed $where is private"; }

# ── 3. credentials ───────────────────────────────────────────────────────────
# `wt.sh land` runs a bare `git fetch`/`git push`, so the token cannot live in this
# script — it has to be something plain git finds on its own. A machine-wide helper
# reads it out of the encrypted store per call: never in a config file, a remote URL
# or an argv.
#
# This comes AFTER the API calls on purpose. A machine whose store has no GITLAB_TOKEN
# should fail without having had a script and a git config entry written into it —
# spark is deliberately kept off this GitLab, and running the command there used to
# leave both behind before giving up.
HELPER=$HOME/.claude/bin/git-credential-gitlab-secret
if [ ! -x "$HELPER" ]; then
  mkdir -p "$(dirname "$HELPER")"
  cat > "$HELPER" <<'SH'
#!/bin/sh
[ "$1" = get ] || exit 0
echo username=oauth2
exec secret exec GITLAB_TOKEN -- sh -c 'printf "password=%s\n" "$GITLAB_TOKEN"'
SH
  chmod +x "$HELPER"
  echo "installed git credential helper $HELPER"
fi
git config --global "credential.$HOST.helper" "$HELPER"

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
