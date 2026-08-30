#!/bin/bash
# rollout-fewer-round-trips.sh — add the '## Fewer round trips' section to every
# agent's AGENTS.md on this machine. sway, 2026-08-30: measured sessions spend
# 2/3-3/4 of wall clock on model reasoning between tool calls, not on the
# commands — batching round trips is the biggest lever left.
#
# Add-only and idempotent: inserts the section from the template above
# '## Verifying work' (fallback: above '## Reporting Style', else append).
# An AGENTS.md that already has the heading is left untouched.
#
#   bash scripts/rollout-fewer-round-trips.sh --dry
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${HERMIT_TEMPLATE:-$REPO/apps/cli/template}"
AGENTS_ROOT="${AGENTS_ROOT:-/Users/mac/claudeclaw}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1
grep -q '^## Fewer round trips' "$TEMPLATE/AGENTS.md" || {
  echo "template has no '## Fewer round trips' section" >&2; exit 1; }

splice() {  # argv: <agent AGENTS.md> <dry> -> added | present | (error)
  python3 - "$TEMPLATE/AGENTS.md" "$1" "$2" <<'PY'
import os, sys
tpl, tgt, dry = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
lines = open(tpl).read().splitlines(keepends=True)
start = next(i for i, l in enumerate(lines) if l.startswith('## Fewer round trips'))
end = next(i for i, l in enumerate(lines[start+1:], start+1) if l.startswith('## '))
sec = ''.join(lines[start:end]).rstrip('\n') + '\n\n'
s = open(tgt).read()
if '## Fewer round trips' in s:
    print('present'); raise SystemExit(0)
for anchor in ('## Verifying work', '## Reporting Style'):
    if anchor in s:
        out = s.replace(anchor, sec + anchor, 1); break
else:
    out = s.rstrip('\n') + '\n\n' + sec.rstrip('\n') + '\n'
assert len(out) == len(s) + len(sec) or out.endswith(sec.rstrip('\n') + '\n')
if not dry:
    t = tgt + '.rollout.tmp'; open(t, 'w').write(out)
    assert os.path.getsize(t) > 0; os.replace(t, tgt)
print('added')
PY
}

updated=0; already=0; nofile=0; skipped=0; failed=0
for dir in "$AGENTS_ROOT"/*/; do
  [ -f "$dir/.claude/settings.json" ] || { skipped=$((skipped+1)); continue; }
  am="$dir/AGENTS.md"; [ -f "$am" ] || { nofile=$((nofile+1)); continue; }
  case "$(splice "$am" "$DRY")" in
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
