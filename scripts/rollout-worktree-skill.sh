#!/bin/bash
# rollout-worktree-skill.sh — install the worktree skill + SessionStart notice into
# every agent on this machine. Idempotent: safe to re-run, and re-running is how you
# update an agent after the skill changes.
#
# Source of truth is the template in the hermit-ui checkout, so an agent installed by
# this script and one scaffolded fresh get byte-identical files.
#
#   bash scripts/rollout-worktree-skill.sh          # apply
#   bash scripts/rollout-worktree-skill.sh --dry    # show what would change
set -uo pipefail

TEMPLATE="${HERMIT_TEMPLATE:-/Users/mac/claudeclaw/asst/hermit-ui/apps/cli/template}"
AGENTS_ROOT="${AGENTS_ROOT:-/Users/mac/claudeclaw}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

[ -f "$TEMPLATE/.claude/skills/worktree/SKILL.md" ] || { echo "template missing: $TEMPLATE" >&2; exit 1; }

installed=0; skipped=0
for dir in "$AGENTS_ROOT"/*/; do
    agent=$(basename "$dir")
    # An agent is a directory with a .claude/settings.json. Anything else here
    # (hermit-ui checkouts, scratch dirs) is not ours to touch.
    [ -f "$dir/.claude/settings.json" ] || { skipped=$((skipped+1)); continue; }

    if [ "$DRY" = 1 ]; then
        has_skill=$([ -f "$dir/.claude/skills/worktree/SKILL.md" ] && echo yes || echo no)
        has_hook=$(python3 -c "
import json,sys
d=json.load(open('$dir/.claude/settings.json'))
ss=(d.get('hooks') or {}).get('SessionStart') or []
print('yes' if any('hook-worktree-notice' in h.get('command','') for m in ss for h in m.get('hooks',[])) else 'no')
" 2>/dev/null || echo '?')
        echo "$agent: skill=$has_skill hook=$has_hook"
        continue
    fi

    mkdir -p "$dir/.claude/skills/worktree" "$dir/scripts"
    cp "$TEMPLATE"/.claude/skills/worktree/{wt.sh,wt.test.sh} "$dir/.claude/skills/worktree/"
    cp "$TEMPLATE/scripts/hook-worktree-notice.sh" "$dir/scripts/"
    # SKILL.md carries {{AGENT_DIR}} so the commands it prints are absolute — the
    # agent's shell cwd wanders, and a relative path resolves to nothing from a
    # subdirectory. The scaffolder substitutes this at create time; here we do the
    # same for an agent that already exists.
    sed "s#{{AGENT_DIR}}#${dir%/}#g" "$TEMPLATE/.claude/skills/worktree/SKILL.md" \
        > "$dir/.claude/skills/worktree/SKILL.md"
    chmod +x "$dir/.claude/skills/worktree/wt.sh" "$dir/.claude/skills/worktree/wt.test.sh" \
             "$dir/scripts/hook-worktree-notice.sh"

    python3 - "$dir" <<'PY' || { echo "  ! settings update failed for $agent" >&2; continue; }
import json, shutil, sys
d = sys.argv[1].rstrip('/')
p = f'{d}/.claude/settings.json'
try:
    cfg = json.load(open(p))
except Exception as e:
    print(f'  ! unreadable settings.json: {e}'); raise SystemExit(1)
shutil.copy(p, p + '.bak-worktree')          # one backup per agent, before the edit
cmd = f'{d}/scripts/hook-worktree-notice.sh'
ss = cfg.setdefault('hooks', {}).setdefault('SessionStart', [])
# Replace any older entry for this hook rather than stacking duplicates.
for m in ss:
    m['hooks'] = [h for h in m.get('hooks', []) if 'hook-worktree-notice' not in h.get('command', '')]
ss[:] = [m for m in ss if m.get('hooks')]
ss.append({'hooks': [{'type': 'command', 'command': cmd, 'timeout': 10}]})
json.dump(cfg, open(p, 'w'), indent=2)
open(p, 'a').write('\n')
PY
    echo "$agent: installed"
    installed=$((installed+1))
done

echo
echo "worktree skill: installed into $installed agent(s), skipped $skipped non-agent dir(s)"
[ "$DRY" = 1 ] || echo "New sessions pick it up at their next start; existing sessions keep running as they are."
