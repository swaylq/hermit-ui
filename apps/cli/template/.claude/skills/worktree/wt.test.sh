#!/usr/bin/env bash
# Self-test for wt.sh against throwaway repos. No tmux required: the session list is
# injected through HERMIT_WT_SELF / HERMIT_WT_SESSIONS, which is the whole reason
# those overrides exist.
#
# The last block is the exception, and deliberately so: it drops HERMIT_WT_SELF and
# makes wt.sh derive its own identity from HERMIT_SESSION_ID. That is the path the
# claude-sdk backend actually takes, and the one whose absence let a tmux-only
# implementation report "sole session" to ten concurrent sessions (2026-08-21).
#
# Run: bash wt.test.sh
set -uo pipefail

WT=$(cd "$(dirname "$0")" && pwd)/wt.sh
TMP=$(mktemp -d)
export HERMIT_WT_ROOT="$TMP/worktrees"
AGENT_DIR="$TMP/agent"
pass=0; fail=0

ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
has()  { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "[$2] does not contain [$3]" ;; esac; }

# A bare "remote" plus a main checkout, standing in for origin + the agent's repo.
setup_repo() {
  rm -rf "$AGENT_DIR"; mkdir -p "$AGENT_DIR"
  git init --quiet --bare "$TMP/origin.git"
  git clone --quiet "$TMP/origin.git" "$AGENT_DIR/proj"
  git -C "$AGENT_DIR/proj" config user.email t@t; git -C "$AGENT_DIR/proj" config user.name t
  echo one > "$AGENT_DIR/proj/a.txt"
  git -C "$AGENT_DIR/proj" add -A; git -C "$AGENT_DIR/proj" commit --quiet -m first
  git -C "$AGENT_DIR/proj" push --quiet -u origin HEAD:main 2>/dev/null
  git -C "$AGENT_DIR/proj" branch --quiet -M main 2>/dev/null
}

echo "== check: sole session =="
setup_repo
out=$(HERMIT_WT_SELF=hermit-aaa HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR" \
      "$WT" check "$AGENT_DIR/proj" 2>&1)
has "sole session is not isolated" "$out" "isolated=no"

echo "== check: sibling present =="
out=$(HERMIT_WT_SELF=hermit-aaa HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR hermit-bbb:$AGENT_DIR" \
      "$WT" check "$AGENT_DIR/proj" 2>&1)
has "sibling triggers isolation" "$out" "isolated=needed"
has "sibling is named" "$out" "hermit-bbb"

echo "== check: another agent's session is not a sibling =="
out=$(HERMIT_WT_SELF=hermit-aaa HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR hermit-ccc:/somewhere/else" \
      "$WT" check "$AGENT_DIR/proj" 2>&1)
has "different agent dir ignored" "$out" "isolated=no"

echo "== enter: creates, and is idempotent =="
env_two() { HERMIT_WT_SELF=hermit-bbb HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR hermit-bbb:$AGENT_DIR" "$@"; }
wt1=$(env_two "$WT" enter "$AGENT_DIR/proj")
[ -d "$wt1" ] && ok "worktree created at $wt1" || bad "worktree created" "$wt1 missing"
check "path is session-derived" "$(basename "$wt1")" "bbb"
wt2=$(env_two "$WT" enter "$AGENT_DIR/proj")
check "enter is idempotent" "$wt2" "$wt1"
check "branch is session-derived" "$(git -C "$wt1" rev-parse --abbrev-ref HEAD)" "wt/bbb"

echo "== enter: from inside a worktree returns itself =="
out=$(env_two "$WT" enter "$wt1")
check "enter inside a worktree is a no-op" "$out" "$wt1"
out=$(env_two "$WT" check "$wt1" 2>&1)
has "check inside a worktree says already" "$out" "isolated=already"

echo "== the main checkout is untouched while the worktree works =="
before=$(git -C "$AGENT_DIR/proj" rev-parse HEAD)
before_branch=$(git -C "$AGENT_DIR/proj" rev-parse --abbrev-ref HEAD)
echo two > "$wt1/b.txt"
git -C "$wt1" config user.email t@t; git -C "$wt1" config user.name t
git -C "$wt1" add -A; git -C "$wt1" commit --quiet -m "from worktree"
check "main checkout HEAD unchanged" "$(git -C "$AGENT_DIR/proj" rev-parse HEAD)" "$before"
check "main checkout still on its branch" "$(git -C "$AGENT_DIR/proj" rev-parse --abbrev-ref HEAD)" "$before_branch"
[ -f "$AGENT_DIR/proj/b.txt" ] && bad "worktree file leaked into main checkout" "b.txt present" || ok "worktree file stayed in the worktree"

echo "== land: pushes to base without checking it out =="
out=$(env_two "$WT" land "$wt1" 2>&1)
has "land reports the commit" "$out" "landed 1 commit"
check "remote base advanced" "$(git -C "$TMP/origin.git" rev-parse main)" "$(git -C "$AGENT_DIR/proj" rev-parse origin/main 2>/dev/null || echo unknown)"
[ -d "$wt1" ] && bad "worktree removed" "$wt1 still there" || ok "worktree removed after landing"
check "main checkout STILL never switched" "$(git -C "$AGENT_DIR/proj" rev-parse --abbrev-ref HEAD)" "$before_branch"
git -C "$AGENT_DIR/proj" fetch --quiet origin
check "main checkout sees the work after a fetch" \
  "$(git -C "$AGENT_DIR/proj" rev-list --count HEAD..origin/main)" "1"

echo "== land: refuses a dirty worktree =="
wt3=$(env_two "$WT" enter "$AGENT_DIR/proj")
echo dirt > "$wt3/dirty.txt"
out=$(env_two "$WT" land "$wt3" 2>&1); rc=$?
check "dirty land exits non-zero" "$rc" "1"
has "dirty land explains itself" "$out" "uncommitted changes"

echo "== sweep: keeps an orphan with unmerged work, removes a clean one =="
git -C "$wt3" config user.email t@t; git -C "$wt3" config user.name t
git -C "$wt3" add -A; git -C "$wt3" commit --quiet -m "unmerged work"
# hermit-bbb is now "gone" — only hermit-aaa remains live.
out=$(HERMIT_WT_SELF=hermit-aaa HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR" \
      "$WT" sweep "$AGENT_DIR/proj" 2>&1)
has "orphan with work is kept" "$out" "KEEP"
[ -d "$wt3" ] && ok "kept worktree still on disk" || bad "kept worktree still on disk" "gone"

wt4_env() { HERMIT_WT_SELF=hermit-ddd HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR hermit-ddd:$AGENT_DIR" "$@"; }
wt4=$(wt4_env "$WT" enter "$AGENT_DIR/proj")
out=$(HERMIT_WT_SELF=hermit-aaa HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR" \
      "$WT" sweep "$AGENT_DIR/proj" 2>&1)
has "clean orphan is removed" "$out" "removed $wt4"
[ -d "$wt4" ] && bad "clean orphan removed from disk" "still there" || ok "clean orphan removed from disk"

echo "== a live session's worktree is never swept =="
out=$(HERMIT_WT_SELF=hermit-aaa HERMIT_WT_SESSIONS="hermit-aaa:$AGENT_DIR hermit-bbb:$AGENT_DIR" \
      "$WT" sweep "$AGENT_DIR/proj" 2>&1)
[ -d "$wt3" ] && ok "live session's worktree survives sweep" || bad "live session's worktree survives sweep" "removed!"

echo "== identity comes from HERMIT_SESSION_ID when there is no tmux (claude-sdk) =="
# The gateway names a session `hermit-<last 12 chars>`; wt.sh must derive the same
# name from the env var alone, or it counts ITSELF as a sibling and never stops.
unset HERMIT_WT_SELF
out=$(HERMIT_SESSION_ID=cmt28m7ot07s7pvdhyurhya3k \
      HERMIT_WT_SESSIONS="hermit-pvdhyurhya3k:$AGENT_DIR hermit-bbb:$AGENT_DIR" \
      "$WT" siblings 2>&1)
check "self is identified from the env var" "$out" "hermit-bbb"

out=$(HERMIT_SESSION_ID=cmt28m7ot07s7pvdhyurhya3k \
      HERMIT_WT_SESSIONS="hermit-pvdhyurhya3k:$AGENT_DIR" \
      "$WT" check "$AGENT_DIR/proj" 2>&1)
has "sole sdk session is not isolated" "$out" "isolated=no"

# A short id must survive verbatim, not be padded or truncated into something else.
out=$(HERMIT_SESSION_ID=short1 HERMIT_WT_SESSIONS="hermit-short1:$AGENT_DIR hermit-bbb:$AGENT_DIR" \
      "$WT" siblings 2>&1)
check "a sub-12-char id is used as-is" "$out" "hermit-bbb"

echo "== siblings answers about the directory it is ASKED about =="
# Without this the answer silently belongs to whichever agent exported
# HERMIT_SESSION_ID into the environment — a cross-agent check that looks right.
mkdir -p "$TMP/other"
out=$(HERMIT_SESSION_ID=cmt28m7ot07s7pvdhyurhya3k \
      HERMIT_WT_SESSIONS="hermit-pvdhyurhya3k:$AGENT_DIR hermit-bbb:$AGENT_DIR hermit-ccc:$TMP/other" \
      "$WT" siblings "$TMP/other" 2>&1)
check "explicit dir wins over the caller's own" "$out" "hermit-ccc"

# An explicitly empty session list means "nobody", not "go read the real machine".
out=$(HERMIT_SESSION_ID=cmt28m7ot07s7pvdhyurhya3k HERMIT_WT_SESSIONS="" \
      "$WT" siblings 2>&1)
check "empty session list means no siblings" "$out" ""

rm -rf "$TMP"
echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
