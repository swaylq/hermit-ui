---
name: reshape-agent
description: Use when migrating an OLD-style agent to the latest hermit-ui template — an agent on the openclaw / telegram-channel / pre-template layout (top-level SOUL.md / HEARTBEAT.md / ACCOUNTS.md, `--channels plugin:telegram`, no `evolution/` dir), or when the user says "规整 agent", "reshape to template", "对齐 template", "迁离 telegram", or "onboard an old agent to the dashboard".
user_invocable: true
---

# reshape-agent — migrate an old agent to the latest hermit-ui template

Convert a pre-template / telegram-era agent into the current hermit-ui template
form: template docs + an `evolution/` scaffold, telegram fully stripped, base
skills refreshed, then dashboard-managed. The deterministic restructuring lives in
`reshape.sh` (this dir); this runbook wraps it with the steps that need judgment.
Battle-tested on asst (2026-05-29), tax/game/d (2026-06-02), asst_2→asst (2026-06-03).

## HARD-GATE: get the human's approval before touching files

This **stops a running agent** and **restructures its workspace** — irreversible-ish
even with backups. Present a plan and get an explicit OK first (every prior reshape
did). Confirm these four:

1. **Telegram scope** — just this agent, or strip telegram across the whole machine?
2. **Custom skills** — which to keep vs drop? (telegram/legacy ones go.)
3. **Rename?** — e.g. `asst_2` → `asst`, and the final name.
4. **OK to stop the running agent** + remove its launchd autostart?

Do not run `reshape.sh` before approval. Violating the letter of this gate violates
its spirit — no "it's obviously fine, I'll just start" exceptions.

## Steps

### 1. Stop the old agent (if running) — launchd FIRST, then kill
Unload its watchdogs **before** killing, or they respawn the telegram process.
```bash
UIDN=$(id -u)
mkdir -p ~/.reshape-launchd-disabled
for p in ~/Library/LaunchAgents/com.hermit-agent.<OLDNAME>.*.plist; do
  [ -e "$p" ] || continue
  launchctl bootout gui/$UIDN "$p" 2>/dev/null || launchctl unload "$p" 2>/dev/null
  mv "$p" ~/.reshape-launchd-disabled/
done
tmux kill-session -t claude-<OLDNAME> 2>/dev/null
[ -f <OLDDIR>/agent.pid ] && kill "$(cat <OLDDIR>/agent.pid)" 2>/dev/null
```

### 2. Back up (always — reshape is destructive)
```bash
tar czf ~/<OLDNAME>.backup-$(date +%F).tar.gz --exclude='*/node_modules' -C "$(dirname <OLDDIR>)" "$(basename <OLDDIR>)"
```

### 3. Read the old persona, then run `reshape.sh`
**Before** running: read the old `IDENTITY.md` / `SOUL.md` / `USER.md` so you can
re-author the persona afterward (the script overwrites them) and set `reshape.sh`'s
`DISPLAY_NAME` (titlecase of the name), `USER_NAME` (the human's name, from old USER.md),
and `PERSONA` vars.
Then edit the vars at the top of `reshape.sh` and run it (one bash block). It
renames, renders template docs, builds `evolution/`, migrates `memory/` →
`evolution/reflections/`, overlays template scripts, refreshes base skills, drops
telegram/legacy skills+scripts, and rewrites settings — then prints a telegram sweep.

### 4. Re-author persona
Edit the new `IDENTITY.md` Mission block + `USER.md` to capture what you read in
step 3 (the template ships generic placeholders). Keep it honest and short.

### 5. Folder trust — CRITICAL, or the agent hangs silently
`--dangerously-skip-permissions` does **NOT** skip the "Do you trust this folder?"
prompt. Any path the gateway-spawned claude hasn't trusted hangs on that TUI prompt,
invisible in the dashboard — a rename guarantees an untrusted path, but an existing
one may never have been trusted via the gateway either. **Always run this, rename or not:**
```bash
cp ~/.claude.json ~/.claude.json.bak-$(date +%F)
jq --arg d "<AGENT_DIR>" '.projects[$d] = ((.projects[$d] // {}) + {hasTrustDialogAccepted:true, hasCompletedProjectOnboarding:true})' ~/.claude.json > /tmp/cj.$$ && mv /tmp/cj.$$ ~/.claude.json
```

### 6. Import to the dashboard
```bash
curl -s -X POST "$DASHBOARD_URL/api/trpc/agents.requestImport?batch=1" \
  -H 'content-type: application/json' -H "x-asst-key: <THIS MACHINE'S KEY>" \
  --data "{\"0\":{\"json\":{\"directory\":\"<AGENT_DIR>\"}}}"
```
`<THIS MACHINE'S KEY>` = the gateway's `ASST_KEY` — read it from
`~/hermit-ui/apps/gateway/.env` on this host (never echo it). Name derives from the
dir basename. The gateway's next `pushAgents` syncs content (restart it to speed up).

### 7. Verify
- **Telegram sweep CLEAN** (the script prints this; expect no hits).
- **Boots clean**: spawn `claude --dangerously-skip-permissions` in a throwaway tmux,
  `capture-pane` → it reaches the `❯` REPL, NOT the trust prompt.
- **Dashboard** `agents.byName` shows identity/skills, telegram-free.

## Strip vs keep

| Strip | Keep |
|---|---|
| `enabledPlugins.telegram`, `mcp__plugin_telegram_*` perms, tg-reply Stop hook | `env.BRAVE_API_KEY` / `GITHUB_TOKEN` / `VPS_SUDO_PASSWORD` |
| `TELEGRAM_*` env, `--channels plugin:telegram` in start.sh | the agent's genuinely-custom skills + work/project dirs |
| skills: add-telegram-user, migrate-openclaw, restart, reset-project | base skills (refreshed from template) |
| scripts: bun-watchdog, patch-telegram-plugin, hook-tg-*, idle-hibernator, wake-poller, pid-snapshot | `memory/` daily logs → `evolution/reflections/` |
| top-level SOUL/HEARTBEAT/ACCOUNTS (soul folds into IDENTITY, accounts into TOOLS) | curated `MEMORY.md` → `evolution/reflections/<date>-legacy-MEMORY.md` |

## Common mistakes
- **Skipping trust (step 5)** → gateway chat sessions hang silently on the trust prompt.
- **Killing before unloading launchd** → watchdogs respawn the telegram process.
- **Blindly overwriting docs** → IDENTITY/USER carry persona; read them first (step 3), re-author after (step 4).
- **`rm` instead of `tar` backup** → always back up; reshape is destructive.
- **Clobbering settings.local secrets** → jq-strip ONLY `TELEGRAM_*`; keep the other env.
- **Telegram-named custom skills survive** → the script drops only a fixed name list; the end-of-run telegram sweep flags any custom skill still mentioning telegram (`.claude/skills/<name>` hits) — review and `rm -rf` those yourself.
- **Cold-start impatience** → the first dashboard chat after reshape cold-starts slowly (~24s); a one-off "Timed out waiting for transcript" warning is benign if the transcript then appears.

## Rollback
`tar xzf ~/<OLDNAME>.backup-<date>.tar.gz -C ~` (restores the workspace), move plists
back from `~/.reshape-launchd-disabled/`, restore `~/.claude.json.bak-<date>`.
