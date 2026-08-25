#!/bin/bash
# rollout-cron-merge.sh — retire the `loop` skill and install the merged `cron` skill
# plus the new `perfect-goal` skill into every agent on this machine.
#
# WHY THIS EXISTS: `loop` and `cron` were the same feature described twice. A loop was
# session-scoped (died on restart, never reached /cron); a cron is durable, listed on
# /cron, and has posted each run's report into the chat that created it ever since the
# reportSessionId migration. So loop is gone and cron absorbed it — a run can now end
# its own cron (a lone CRON_DONE line) and re-pace it (CRON_NEXT <minutes>).
#
# Source of truth is the template in the hermit-ui checkout, so an agent updated by this
# script and one scaffolded fresh get byte-identical files.
#
#   bash scripts/rollout-cron-merge.sh          # apply
#   bash scripts/rollout-cron-merge.sh --dry    # show what would change
#
# Idempotent: safe to re-run, and re-running is how you update an agent after either
# SKILL.md changes.
set -uo pipefail

TEMPLATE="${HERMIT_TEMPLATE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apps/cli/template}"
AGENTS_ROOT="${AGENTS_ROOT:-/Users/mac/claudeclaw}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

for f in cron perfect-goal; do
    [ -f "$TEMPLATE/.claude/skills/$f/SKILL.md" ] || {
        echo "template missing: $TEMPLATE/.claude/skills/$f/SKILL.md" >&2; exit 1; }
done
[ -d "$TEMPLATE/.claude/skills/loop" ] && {
    echo "refusing: $TEMPLATE still ships a loop skill — delete it there first" >&2; exit 1; }

updated=0; skipped=0; dropped=0
for dir in "$AGENTS_ROOT"/*/; do
    agent=$(basename "$dir")
    # An agent is a directory with a .claude/settings.json. Anything else here
    # (hermit-ui checkouts, scratch dirs) is not ours to touch.
    [ -f "$dir/.claude/settings.json" ] || { skipped=$((skipped+1)); continue; }
    dir=${dir%/}

    has_loop=$([ -d "$dir/.claude/skills/loop" ] && echo yes || echo no)
    if [ "$DRY" = 1 ]; then
        has_pg=$([ -f "$dir/.claude/skills/perfect-goal/SKILL.md" ] && echo yes || echo no)
        stale=$(cmp -s "$dir/.claude/skills/cron/SKILL.md" \
                       <(sed "s#{{AGENT_DIR}}#$dir#g" "$TEMPLATE/.claude/skills/cron/SKILL.md") \
                && echo no || echo yes)
        echo "$agent: loop=$has_loop cron-stale=$stale perfect-goal=$has_pg"
        continue
    fi

    # Both SKILL.md files carry {{AGENT_DIR}} so the commands they print are absolute —
    # an agent's shell cwd wanders, and a relative path resolves to nothing from a
    # subdirectory. The scaffolder substitutes this at create time; do the same here.
    for f in cron perfect-goal; do
        mkdir -p "$dir/.claude/skills/$f"
        sed "s#{{AGENT_DIR}}#$dir#g" "$TEMPLATE/.claude/skills/$f/SKILL.md" \
            > "$dir/.claude/skills/$f/SKILL.md.tmp" \
            && mv "$dir/.claude/skills/$f/SKILL.md.tmp" "$dir/.claude/skills/$f/SKILL.md" \
            || { echo "  ! write failed for $agent/$f" >&2; continue 2; }
    done

    # The loop skill's directory goes, but a live loop's STATE file does not: an agent
    # mid-loop keeps .loop-state.json until its next restart, and deleting it under a
    # running session would strand the loop with no record of itself. Nothing reads the
    # file any more (the gateway stopped collecting it), so it is inert — leave it and
    # let the agent's own tidying remove it.
    if [ "$has_loop" = yes ]; then
        rm -rf "$dir/.claude/skills/loop" && dropped=$((dropped+1))
    fi

    # Every agent's AGENTS.md carries one sentence pointing at the skill we just
    # deleted, under "Cron / Scheduled Tasks — HARD RULE". A rule that names a
    # nonexistent skill is worse than no rule: the agent reaches for it, finds
    # nothing, and improvises. The sentence is wrapped differently in different
    # agents, hence the whitespace-tolerant match; anything that does not match
    # exactly is left alone and reported.
    fixed_md=$(python3 - "$dir" <<'PY' 2>/dev/null || echo err
import re, sys, os
p = os.path.join(sys.argv[1], 'AGENTS.md')
try:
    s = open(p, encoding='utf-8').read()
except OSError:
    print('none'); raise SystemExit(0)
new = ('A 定时任务 and a 循环 are the same object here; there is no separate loop skill, '
       'and every run reports back into the chat that created it.')
out, n = re.subn(r'For an in-conversation\s+loop, use the `loop` skill\.', new, s)
if n:
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(out)
    assert os.path.getsize(tmp) > 0
    os.replace(tmp, p)
print('yes' if n else 'no')
PY
)

    updated=$((updated+1))
    note=""
    [ "$has_loop" = yes ] && note="$note, loop removed"
    [ "$fixed_md" = yes ] && note="$note, AGENTS.md sentence fixed"
    [ "$fixed_md" = err ] && note="$note, ! AGENTS.md edit FAILED"
    echo "$agent: cron+perfect-goal installed$note"
done

if [ "$DRY" = 1 ]; then
    echo "(dry run — nothing written)"
else
    echo "---"
    echo "updated $updated agent(s); removed the loop skill from $dropped; skipped $skipped non-agent dir(s)"
    echo "Agents pick this up on their NEXT session — a live session already listed the old skills."
fi
