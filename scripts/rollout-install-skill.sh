#!/bin/bash
# rollout-install-skill.sh <skill-name> — install or update ONE template skill for
# every agent on this machine, creating the skill dir where it does not exist.
#
# The older rollout scripts only refresh files already present, which is why
# perfect-goal never reached the other machines (2026-08-29 note: sway003 1/27,
# macmini003 0/23, spark 0/2). This one closes that gap. {{AGENT_DIR}} in the
# template is substituted with the agent's directory. Idempotent.
#
#   bash scripts/rollout-install-skill.sh perfect-goal [--dry]
set -uo pipefail
SKILL="${1:?usage: rollout-install-skill.sh <skill-name> [--dry]}"
DRY=0; [ "${2:-}" = "--dry" ] && DRY=1
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${HERMIT_TEMPLATE:-$REPO/apps/cli/template}"
AGENTS_ROOT="${AGENTS_ROOT:-/Users/mac/claudeclaw}"
SRC="$TEMPLATE/.claude/skills/$SKILL"
[ -d "$SRC" ] || { echo "template has no skill '$SKILL' at $SRC" >&2; exit 1; }

installed=0; refreshed=0; already=0; skipped=0
for dir in "$AGENTS_ROOT"/*/; do
  [ -f "$dir/.claude/settings.json" ] || { skipped=$((skipped+1)); continue; }
  dst="$dir.claude/skills/$SKILL"
  new=0; [ -d "$dst" ] || new=1
  changed=0
  while IFS= read -r -d '' f; do
    rel="${f#"$SRC"/}"
    want="$(sed "s#{{AGENT_DIR}}#${dir%/}#g" "$f")"
    if [ -f "$dst/$rel" ] && [ "$want" = "$(cat "$dst/$rel")" ]; then continue; fi
    changed=1
    if [ "$DRY" = 1 ]; then echo "would write  $(basename "$dir")/.claude/skills/$SKILL/$rel"
    else mkdir -p "$(dirname "$dst/$rel")"; printf '%s\n' "$want" > "$dst/$rel"; fi
  done < <(find "$SRC" -type f -print0)
  if [ "$changed" = 0 ]; then already=$((already+1))
  elif [ "$new" = 1 ]; then installed=$((installed+1))
  else refreshed=$((refreshed+1)); fi
done
echo "installed $installed · refreshed $refreshed · already current $already · not an agent $skipped"
