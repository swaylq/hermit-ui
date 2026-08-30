#!/bin/bash
# rollout-verify-proportional.sh — push "match the check to the size of the change"
# into every agent already on this machine.
#
# sway, 2026-08-30: the 2026-08-29 policy ("build every round, end-to-end once at the
# end") stopped agents writing unit suites, but not from firing the project's HEAVY
# suite at a trivial change. A text-game session spent 27 minutes on "make a tooltip
# last longer + fix a clipped button": three runs of a 347-check headless-browser
# acceptance suite, ~3 min each, the third one purely to prove that a check it had
# just written went red on the old code. Simple change -> it builds, you look at it,
# done. Heavy pass is for a complex change.
#
# Touches three files per agent:
#   .claude/skills/perfect-goal/SKILL.md   suite cost weighed; scale the e2e to the change
#   .claude/skills/cron/SKILL.md           same, for the iterate-until-done family
#   AGENTS.md                              the '## Verifying work' section, rewritten
#
# Source of truth is the template in the hermit-ui checkout, so an agent updated by
# this script and one scaffolded fresh get byte-identical files.
#
#   bash scripts/rollout-verify-proportional.sh --dry   # show what would change
#   bash scripts/rollout-verify-proportional.sh         # apply
#
# Idempotent: re-running is a clean no-op.
#
# Unlike rollout-testing-policy.sh (which only ever ADDED the section), this one
# REPLACES it — so it refuses to touch an AGENTS.md whose section matches neither the
# old template text nor the new one. That is a hand-edited section; it gets reported as
# `custom` and left exactly as it is, for a human to reconcile.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${HERMIT_TEMPLATE:-$REPO/apps/cli/template}"
# Every past version of the section we are willing to overwrite. Add a snapshot here
# BEFORE editing the template again, or the next roll will see every agent as
# hand-edited and skip them all.
KNOWN="${HERMIT_VERIFY_KNOWN:-$REPO/scripts/rollout-data}"
AGENTS_ROOT="${AGENTS_ROOT:-/Users/mac/claudeclaw}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

for f in .claude/skills/perfect-goal/SKILL.md .claude/skills/cron/SKILL.md AGENTS.md; do
  [ -f "$TEMPLATE/$f" ] || { echo "template missing: $TEMPLATE/$f" >&2; exit 1; }
done
ls "$KNOWN"/verifying-work-*.txt >/dev/null 2>&1 || {
  echo "no previous-section snapshots in $KNOWN" >&2; exit 1; }
grep -q '^## Verifying work' "$TEMPLATE/AGENTS.md" || {
  echo "template AGENTS.md has no '## Verifying work' section — wrong template?" >&2; exit 1; }
grep -q 'Match the check to the size of the change' "$TEMPLATE/AGENTS.md" || {
  echo "template AGENTS.md is missing the new rule — stale template?" >&2; exit 1; }

# Section surgery on one agent's AGENTS.md.
#   argv: <template AGENTS.md> <snapshot dir> <agent AGENTS.md> <dry:0|1>
#   prints one word: added | appended | replaced | present | custom
splice() {
  python3 - "$TEMPLATE/AGENTS.md" "$KNOWN" "$1" "$2" <<'PY'
import os, sys
tpl, known, tgt, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'

def section(text):
    """The '## Verifying work' block, or None."""
    lines = text.splitlines(keepends=True)
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith('## Verifying work'))
    except StopIteration:
        return None, None, None
    end = next((i for i, l in enumerate(lines[start+1:], start+1) if l.startswith('## ')),
               len(lines))
    return ''.join(lines[start:end]), start, end

want = section(open(tpl).read())[0].rstrip('\n') + '\n\n'
olds = [open(os.path.join(known, f)).read().rstrip('\n')
        for f in sorted(os.listdir(known)) if f.startswith('verifying-work-')]

s = open(tgt).read()
cur, start, end = section(s)

if cur is None:
    if '## Reporting Style' in s:
        out, word = s.replace('## Reporting Style', want + '## Reporting Style', 1), 'added'
    else:
        out, word = s.rstrip('\n') + '\n\n' + want.rstrip('\n') + '\n', 'appended'
elif cur.rstrip('\n') == want.rstrip('\n'):
    print('present'); raise SystemExit(0)
elif cur.rstrip('\n') in olds:
    lines = s.splitlines(keepends=True)
    out, word = ''.join(lines[:start]) + want + ''.join(lines[end:]), 'replaced'
else:
    print('custom'); raise SystemExit(0)

# Compute fully, sanity-check, then land atomically — never truncate in place.
assert '## Verifying work' in out and 'Match the check to the size' in out
assert len(out) > len(s) - 400, 'unexpected shrinkage'
if not dry:
    tmp = tgt + '.rollout.tmp'
    open(tmp, 'w').write(out)
    assert os.path.getsize(tmp) > 0
    os.replace(tmp, tgt)
print(word)
PY
}

updated=0; already=0; nofile=0; skipped=0; custom=0

for dir in "$AGENTS_ROOT"/*/; do
  agent=$(basename "$dir")
  # An agent is a directory with .claude/settings.json. Anything else in here
  # (hermit-ui checkouts, scratch dirs) is not ours to touch.
  [ -f "$dir/.claude/settings.json" ] || { skipped=$((skipped+1)); continue; }

  for rel in .claude/skills/perfect-goal/SKILL.md .claude/skills/cron/SKILL.md; do
    tgt="$dir$rel"
    [ -f "$tgt" ] || continue
    # The template carries {{AGENT_DIR}}; an installed copy has it substituted.
    want="$(sed "s#{{AGENT_DIR}}#${dir%/}#g" "$TEMPLATE/$rel")"
    if [ "$want" = "$(cat "$tgt")" ]; then already=$((already+1)); continue; fi
    if [ "$DRY" = 1 ]; then echo "would update  $agent/$rel"
    else printf '%s\n' "$want" > "$tgt"; fi
    updated=$((updated+1))
  done

  am="$dir/AGENTS.md"
  [ -f "$am" ] || { nofile=$((nofile+1)); continue; }
  case "$(splice "$am" "$DRY")" in
    present) already=$((already+1)) ;;
    custom)  echo "CUSTOM — left alone: $agent/AGENTS.md (## Verifying work is hand-edited)"
             custom=$((custom+1)) ;;
    added|appended|replaced)
      [ "$DRY" = 1 ] && echo "would rewrite $agent/AGENTS.md  (## Verifying work)"
      updated=$((updated+1)) ;;
  esac
done

echo
echo "updated $updated · already current $already · hand-edited $custom · no AGENTS.md $nofile · not an agent $skipped"
[ "$DRY" = 1 ] && echo "(dry run — nothing written)"
exit 0
