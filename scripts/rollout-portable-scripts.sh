#!/bin/bash
# rollout-portable-scripts.sh — push the cross-platform script layer into every
# agent on this machine. Idempotent: safe to re-run, and re-running is how you
# update an agent after the template changes.
#
# Source of truth is the template in the hermit-ui checkout, so an agent updated
# by this script and one scaffolded fresh get byte-identical files.
#
#   bash scripts/rollout-portable-scripts.sh --dry   # show what would change
#   bash scripts/rollout-portable-scripts.sh         # apply
#
# WHY THIS EXISTS: apps/cli/template is the source for `create-hermit-agent` and
# for the dashboard's "new from template", but an agent that already exists
# never re-reads it. Without this, the Linux fixes land for future agents only —
# and every agent already on the machine keeps a `safe-image.sh` that is a
# `sips` call and hooks that need a `jq` Ubuntu does not have.
#
# WHAT IT TOUCHES (nothing else — no settings.json, no markdown, no state):
#   scripts/lib/{platform,image,json}.sh   new, the shared backends
#   scripts/safe-image.sh                  now a thin wrapper over lib/image.sh
#   scripts/hooks/pre-read-image.sh        blocks loudly with no backend
#   scripts/hook-web-permission.sh         warns instead of silently deferring
#   scripts/hook-session-state.sh          jq-or-node
#   scripts/reap-dead-sessions.sh          jq-or-node
#   scripts/chrome-launcher.sh             xvfb / headless fallback on Linux
#
# A copy is skipped when the agent's file is already byte-identical, so a
# re-run over a settled fleet reports "0 updated" and touches no mtimes.

set -uo pipefail

TEMPLATE="${HERMIT_TEMPLATE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apps/cli/template}"
AGENTS_ROOT="${AGENTS_ROOT:-/Users/mac/claudeclaw}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

[ -f "$TEMPLATE/scripts/lib/image.sh" ] || { echo "template missing: $TEMPLATE" >&2; exit 1; }

# Relative paths under the agent directory. lib/ first: the others source it,
# so an interrupted run leaves scripts that still have their dependency.
FILES=(
  scripts/lib/platform.sh
  scripts/lib/image.sh
  scripts/lib/json.sh
  scripts/lib/lib.test.sh
  scripts/safe-image.sh
  scripts/hooks/pre-read-image.sh
  scripts/hook-web-permission.sh
  scripts/hook-session-state.sh
  scripts/reap-dead-sessions.sh
  scripts/chrome-launcher.sh
)

updated=0; unchanged=0; agents=0; skipped=0

for dir in "$AGENTS_ROOT"/*/; do
  agent=$(basename "$dir")
  # An agent is a directory with a .claude/settings.json. Anything else here
  # (hermit-ui checkouts, scratch dirs) is not ours to touch.
  [ -f "$dir/.claude/settings.json" ] || { skipped=$((skipped+1)); continue; }
  agents=$((agents+1))
  changed_here=()

  for rel in "${FILES[@]}"; do
    src="$TEMPLATE/$rel"
    dst="$dir$rel"
    [ -f "$src" ] || continue

    # Only replace a file the agent ALREADY has (or a lib, which is new by
    # definition). An agent that never had chrome-launcher.sh does not want one
    # appearing now — this is a portability rollout, not a feature install.
    case "$rel" in
      scripts/lib/*) ;;
      *) [ -f "$dst" ] || continue ;;
    esac

    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
      unchanged=$((unchanged+1))
      continue
    fi
    changed_here+=("$rel")
    if [ "$DRY" = 0 ]; then
      mkdir -p "$(dirname "$dst")"
      # Keep one backup of whatever was there, once. A second run must not
      # overwrite the pre-rollout original with the already-rolled-out version.
      if [ -f "$dst" ] && [ ! -f "$dst.pre-portable" ]; then
        cp "$dst" "$dst.pre-portable"
      fi
      cp "$src" "$dst"
      chmod +x "$dst"
      updated=$((updated+1))
    else
      updated=$((updated+1))
    fi
  done

  if [ ${#changed_here[@]} -gt 0 ]; then
    echo "$agent: ${changed_here[*]}"
  fi
done

echo
if [ "$DRY" = 1 ]; then
  echo "DRY RUN — $agents agents, $updated file(s) would change, $unchanged already current ($skipped non-agent dirs skipped)"
  echo "Re-run without --dry to apply."
else
  echo "$agents agents, $updated file(s) updated, $unchanged already current ($skipped non-agent dirs skipped)"
  echo "Originals kept alongside as <name>.pre-portable (first run only)."
  echo "Verify one agent with: bash $AGENTS_ROOT/<agent>/scripts/lib/lib.test.sh"
fi
