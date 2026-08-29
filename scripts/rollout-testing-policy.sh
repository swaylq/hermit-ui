#!/bin/bash
# rollout-testing-policy.sh — push the "build is the bar, test once at the end"
# policy into every agent already on this machine.
#
# sway, 2026-08-29: agents test far too much, and a self-written unit suite going
# green proves nothing — it encodes the same assumptions that produced the bug.
# The per-round gate is now the BUILD; the end-to-end pass happens once, when the
# feature is finished. Changing the template alone only helps agents scaffolded
# after today, and there are 40+ already on disk.
#
# Touches three files per agent:
#   .claude/skills/perfect-goal/SKILL.md   round = build; e2e + critic when the list looks met
#   .claude/skills/cron/SKILL.md           same, for the iterate-until-done family
#   AGENTS.md                              the general rule, spliced in as one section
#
# Source of truth is the template in the hermit-ui checkout, so an agent updated
# by this script and one scaffolded fresh get byte-identical files.
#
#   bash scripts/rollout-testing-policy.sh --dry   # show what would change
#   bash scripts/rollout-testing-policy.sh         # apply
#
# Idempotent: re-running is how you update an agent after the template changes
# again.
#
# The two SKILL.md files are template-managed and are OVERWRITTEN — same contract
# as rollout-worktree-skill.sh. Measured before the first run: 43 of the 44 agents
# holding these files were byte-identical to the template, so there was nothing
# hand-written to lose. AGENTS.md is only ever ADDED TO (one section, spliced above
# "## Reporting Style"), never rewritten, because that file does carry per-agent
# edits.
set -uo pipefail

TEMPLATE="${HERMIT_TEMPLATE:-/Users/mac/claudeclaw/asst/hermit-ui/apps/cli/template}"
AGENTS_ROOT="${AGENTS_ROOT:-/Users/mac/claudeclaw}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

for f in .claude/skills/perfect-goal/SKILL.md .claude/skills/cron/SKILL.md AGENTS.md; do
  [ -f "$TEMPLATE/$f" ] || { echo "template missing: $TEMPLATE/$f" >&2; exit 1; }
done
grep -q '^## Verifying work' "$TEMPLATE/AGENTS.md" || {
  echo "template AGENTS.md has no '## Verifying work' section — wrong template?" >&2; exit 1; }

# The AGENTS.md surgery. Reads the section straight out of the template file, so
# nothing round-trips through shell quoting.
#   argv: <template AGENTS.md> <agent AGENTS.md> <dry:0|1>
#   exits 0 and prints one word: added | present | appended
splice() {
  python3 - "$TEMPLATE/AGENTS.md" "$1" "$2" <<'PY'
import sys
tpl, tgt, dry = sys.argv[1], sys.argv[2], sys.argv[3] == '1'

lines = open(tpl).read().splitlines(keepends=True)
start = next(i for i, l in enumerate(lines) if l.startswith('## Verifying work'))
end = next(i for i, l in enumerate(lines[start + 1:], start + 1) if l.startswith('## '))
section = ''.join(lines[start:end]).rstrip('\n') + '\n\n'

s = open(tgt).read()
if '## Verifying work' in s:
    print('present'); raise SystemExit(0)

if '## Reporting Style' in s:
    out = s.replace('## Reporting Style', section + '## Reporting Style', 1)
    word = 'added'
else:
    out = s.rstrip('\n') + '\n\n' + section.rstrip('\n') + '\n'
    word = 'appended'
if not dry:
    open(tgt, 'w').write(out)
print(word)
PY
}

updated=0; already=0; nofile=0; skipped=0

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
    added|appended)
      [ "$DRY" = 1 ] && echo "would add     $agent/AGENTS.md  (## Verifying work)"
      updated=$((updated+1)) ;;
  esac
done

echo
echo "updated $updated · already current $already · no AGENTS.md $nofile · not an agent $skipped"
[ "$DRY" = 1 ] && echo "(dry run — nothing written)"
exit 0
