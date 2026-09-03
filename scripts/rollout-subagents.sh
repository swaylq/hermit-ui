#!/bin/bash
# rollout-subagents.sh — add the '## Subagents' section to every agent's AGENTS.md.
# sway, 2026-09-04: measured that subagents went from ~0 to 17% of a machine's token
# spend in three weeks, and their cache expires in 5 minutes and never reads the
# parent's — so "hand the noisy work to a subagent" is not the saving it looks like.
# The rule is deliberately written WITHOUT the numbers ("不用成本写进去") and as a
# not-unless: three lines naming the one case that earns a subagent.
#
# Section text is read from the template, so a rolled agent and a freshly scaffolded
# one are byte-identical. Inserted above '## Verifying work' (fallback: above
# '## Reporting Style', else appended). Add-only: an AGENTS.md that already has the
# heading is left untouched, so a second run is a clean no-op.
#
#   bash scripts/rollout-subagents.sh --dry    # show what would change
#   bash scripts/rollout-subagents.sh          # apply
#   AGENTS_ROOT=~/agents bash scripts/rollout-subagents.sh   # zhinan-macmini001 layout
#
# Every file it rewrites is copied first to ~/.trash-2026-09-04-subagents/ with its
# path flattened, so a rollback is a copy back.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${HERMIT_TEMPLATE:-$REPO/apps/cli/template}"
AGENTS_ROOT="${AGENTS_ROOT:-$HOME/claudeclaw}"
BACKUP="${BACKUP_DIR:-$HOME/.trash-2026-09-04-subagents}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

[ -d "$AGENTS_ROOT" ] || { echo "no agents root: $AGENTS_ROOT" >&2; exit 1; }
grep -q '^## Subagents' "$TEMPLATE/AGENTS.md" || {
  echo "template has no '## Subagents' section: $TEMPLATE/AGENTS.md" >&2; exit 1; }

splice() {  # <agent AGENTS.md> <dry 0|1> <backup dir> -> added | present | (error)
  python3 - "$TEMPLATE/AGENTS.md" "$1" "$2" "$3" <<'PY'
import os, sys
tpl, tgt, dry, backup = sys.argv[1], sys.argv[2], sys.argv[3] == '1', sys.argv[4]
lines = open(tpl).read().splitlines(keepends=True)
start = next(i for i, l in enumerate(lines) if l.startswith('## Subagents'))
end = next(i for i, l in enumerate(lines[start+1:], start+1) if l.startswith('## '))
sec = ''.join(lines[start:end]).rstrip('\n') + '\n\n'
s = open(tgt).read()
if '## Subagents' in s:
    print('present'); raise SystemExit(0)
for anchor in ('## Verifying work', '## Reporting Style'):
    if anchor in s:
        out = s.replace(anchor, sec + anchor, 1); break
else:
    out = s.rstrip('\n') + '\n\n' + sec.rstrip('\n') + '\n'
assert len(out) == len(s) + len(sec), (len(out), len(s), len(sec))
if not dry:
    os.makedirs(backup, exist_ok=True)
    flat = tgt.lstrip('/').replace('/', '_')
    open(os.path.join(backup, flat), 'w').write(s)
    t = tgt + '.rollout.tmp'; open(t, 'w').write(out)
    assert os.path.getsize(t) > 0; os.replace(t, tgt)
print('added')
PY
}

updated=0; already=0; nofile=0; skipped=0; failed=0
for dir in "$AGENTS_ROOT"/*/; do
  [ -f "$dir/.claude/settings.json" ] || { skipped=$((skipped+1)); continue; }
  am="$dir/AGENTS.md"; [ -f "$am" ] || { nofile=$((nofile+1)); continue; }
  case "$(splice "$am" "$DRY" "$BACKUP")" in
    present) already=$((already+1)) ;;
    added)   [ "$DRY" = 1 ] && echo "would add  $(basename "$dir")/AGENTS.md"
             updated=$((updated+1)) ;;
    *) echo "ERROR — splice failed on $(basename "$dir")/AGENTS.md" >&2
       failed=$((failed+1)) ;;
  esac
done
echo "added $updated · present $already · no AGENTS.md $nofile · not an agent $skipped · FAILED $failed"
[ "$failed" -gt 0 ] && exit 1
exit 0
