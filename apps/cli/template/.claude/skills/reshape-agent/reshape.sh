#!/bin/bash
# reshape.sh — deterministic part of reshape-agent (SKILL.md steps wrap it).
# Renames + renders template docs + builds evolution/ + migrates memory + overlays
# template scripts + refreshes base skills + strips telegram/openclaw + rewrites
# settings. EDIT THE VARS, then run as ONE block.
#
# Run AFTER: stopping the old agent + a tar backup (SKILL.md steps 1-2).
# Run BEFORE: re-authoring IDENTITY/USER, folder trust, dashboard import (steps 4-6).
# Custom skills are kept automatically — only the telegram/legacy set below is dropped.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# ───── EDIT THESE ─────
OLD_DIR="$HOME/<oldname>"               # current workspace
AGENT_DIR="$HOME/<name>"                # final workspace (= OLD_DIR if not renaming)
NAME="<name>"                           # final agent name (basename of AGENT_DIR)
DISPLAY_NAME="<Name>"
USER_NAME="<you>"
PERSONA="personal assistant"
DASHBOARD_URL="https://dash.swaylab.ai"
# ──────────────────────

HERMIT="$HOME/hermit-ui"; TPL="$HERMIT/apps/cli/template"; STAMP="$(date +%F)"
fail(){ echo "ABORT: $1" >&2; exit 1; }
[ -d "$OLD_DIR" ] || fail "$OLD_DIR missing"
[ -d "$TPL" ] || fail "template missing — is the gateway installed at ~/hermit-ui?"
command -v jq >/dev/null || fail "jq required"

render(){ sed -i '' \
  -e "s#{{USER_NAME}}#$USER_NAME#g" -e "s#{{AGENT_NAME}}#$NAME#g" \
  -e "s#{{AGENT_DISPLAY_NAME}}#$DISPLAY_NAME#g" -e "s#{{PERSONA}}#$PERSONA#g" \
  -e "s#{{AGENT_DIR}}#$AGENT_DIR#g" -e "s#{{DASHBOARD_URL}}#$DASHBOARD_URL#g" "$1"; }

if [ "$OLD_DIR" != "$AGENT_DIR" ]; then [ -e "$AGENT_DIR" ] && fail "$AGENT_DIR exists"; mv "$OLD_DIR" "$AGENT_DIR"; fi
cd "$AGENT_DIR" || fail "cd failed"

echo "1) template docs (rendered)"
for f in CLAUDE.md IDENTITY.md USER.md AGENTS.md TOOLS.md README.md package.json start.sh restart.sh .gitignore; do
  [ -f "$TPL/$f" ] && { cp "$TPL/$f" "./$f"; render "./$f"; }
done
chmod +x start.sh restart.sh 2>/dev/null

echo "2) evolution scaffold + migrate memory"
mkdir -p evolution/reflections
[ -f MEMORY.md ] && mv MEMORY.md "evolution/reflections/${STAMP}-legacy-MEMORY.md"
# Preserve (don't delete) the old persona/account docs — soul folds into IDENTITY
# during re-authoring, but keep the originals in reflections for reference.
for f in SOUL HEARTBEAT ACCOUNTS; do [ -f "$f.md" ] && mv "$f.md" "evolution/reflections/${STAMP}-legacy-$f.md"; done
[ -f "$TPL/evolution/lessons.md" ] && { cp "$TPL/evolution/lessons.md" evolution/lessons.md; render evolution/lessons.md; }
[ -f "$TPL/evolution/README.md" ] && { cp "$TPL/evolution/README.md" evolution/README.md; render evolution/README.md; }
touch evolution/reflections/.gitkeep
[ -d memory ] && { mv memory/*.md evolution/reflections/ 2>/dev/null; rmdir memory 2>/dev/null || mv memory evolution/reflections/_legacy-memory-dir; }

echo "3) scripts: overlay template + strip telegram/openclaw cruft"
cp -R "$TPL/scripts/." scripts/ 2>/dev/null
rm -f scripts/bun-watchdog.sh scripts/bun-death-*.sh scripts/patch-telegram-plugin.sh \
      scripts/hook-tg-strip-markdown.sh scripts/hook-tool-activity.sh scripts/hook-context-report.sh \
      scripts/idle-hibernator.sh scripts/wake-poller.sh scripts/wake-agent.sh scripts/hibernate-agent.sh \
      scripts/pid-snapshot.sh scripts/multi-agent-status-report.sh* 2>/dev/null
for s in scripts/*.sh scripts/hooks/*.sh; do [ -f "$s" ] && render "$s"; done
chmod +x scripts/*.sh scripts/hooks/*.sh 2>/dev/null

echo "4) skills: refresh base, drop telegram/legacy, keep custom (untouched)"
( cd .claude/skills 2>/dev/null || exit 0
  for sk in brave-search browser-automation cron loop update-hermit reshape-agent; do
    rm -rf "$sk"; [ -d "$TPL/.claude/skills/$sk" ] && cp -R "$TPL/.claude/skills/$sk" "$sk"
  done
  rm -rf add-telegram-user migrate-openclaw reset-project restart provision-agent provision-clone )

echo "5) settings.json = template (rendered); settings.local.json: strip telegram env + canonical hooks, keep secrets"
cp "$TPL/.claude/settings.json" .claude/settings.json; render .claude/settings.json
if [ -f .claude/settings.local.json ]; then
  jq --arg dir "$AGENT_DIR" '{ env: ((.env // {}) | del(.TELEGRAM_BOT_TOKEN,.TELEGRAM_STATE_DIR,.TELEGRAM_CHAT_ID)),
    hooks: { UserPromptSubmit:[{hooks:[{type:"command",command:($dir+"/scripts/hook-session-state.sh")}]}],
      Stop:[{hooks:[{type:"command",command:($dir+"/scripts/hook-session-state.sh")}]}],
      PreToolUse:[{hooks:[{type:"command",command:($dir+"/scripts/hook-session-state.sh")}]},
        {matcher:"Read",hooks:[{type:"command",command:($dir+"/scripts/hooks/pre-read-image.sh"),timeout:10}]},
        {matcher:"AskUserQuestion",hooks:[{type:"command",command:($dir+"/scripts/hook-block-askuserquestion.sh")}]}]}}' \
    .claude/settings.local.json > .claude/settings.local.json.new && mv .claude/settings.local.json.new .claude/settings.local.json
  chmod 600 .claude/settings.local.json
fi
rm -rf .claude/hooks .claude/state 2>/dev/null; rm -f agent.pid restart.log 2>/dev/null

echo ""; echo "===== RESHAPE DONE — now do SKILL.md steps 4-7 (re-author IDENTITY/USER, trust, import, verify) ====="
echo "-- telegram sweep (want CLEAN) --"
grep -ril telegram . --include="*.md" --include="*.json" --include="*.sh" 2>/dev/null | grep -vE "node_modules|evolution/reflections|\.bak" || echo "  CLEAN ✓"
echo "   ↑ any '.claude/skills/<name>' hit = a telegram-coupled CUSTOM skill the fixed"
echo "     drop-list didn't catch — review and 'rm -rf' it yourself."
echo "-- placeholders left (want none) --"; grep -rl "{{" . --include="*.md" --include="*.json" 2>/dev/null | grep -vE "node_modules|reflections" || echo "  none ✓"
echo "-- skills --"; ls .claude/skills
