---
name: update-hermit
description: Pull the latest hermit-ui from GitHub and apply it to THIS machine — update the local gateway (code + deps + pm2 restart) and refresh this agent's base skills + common scripts from the new template. Use when the user says "更新 hermit", "update the gateway", "sync hermit-ui", "拉最新 hermit", "同步更新 hermit", or after the dev source pushes gateway/template changes.
user_invocable: true
---

# update-hermit — sync this machine to the latest hermit-ui

The dev source (the main host's agent) develops hermit-ui and pushes gateway +
template changes to `github.com/swaylq/hermit-ui`. This skill pulls those and
applies them **here**: restarts the local gateway with the new code, and refreshes
this agent's template-managed bits (base skills + common scripts).

Scope: the gateway (machine-wide) + **this one agent's** base bits. Other agents on
the same machine each run it themselves when they want the refresh.

## What it updates

- **Gateway** (`~/hermit-ui`): fast-forward pull → `npm install` (only if deps
  changed) → pm2 restart (delete+start, so the new code actually loads).
- **This agent's base skills**: `brave-search`, `browser-automation`, `cron`,
  `loop`, `update-hermit`, `reshape-agent` — re-copied from the refreshed `apps/cli/template`.
- **This agent's common scripts**: the canonical hook + safety scripts (overlaid;
  your extra scripts are kept).

## What it NEVER touches (your customization)

`IDENTITY` / `USER` / `AGENTS` / `TOOLS` / `CLAUDE` docs, your **custom** skills,
`settings.json`, `settings.local.json`, `evolution/`, `memory/`. Template doc /
settings changes are *surfaced* at the end (not auto-applied) so you can review.

## Safety facts (read before running)

- **Restarting the gateway does NOT kill this chat session.** Your session runs in
  its own tmux pane; the gateway only tails your transcript. On restart it
  re-attaches — your reply streams to the user once it reconnects (~15s). So expect
  a short streaming gap right after the restart; that's normal.
- **Use delete + start, never a bare `pm2 restart`.** The pm2 god-daemon can report
  a bare restart as "done" without actually reloading the new code.
- **Fast-forward only.** The script refuses to run if local `HEAD` has diverged from
  `origin/main` (i.e. on the dev source with unpushed work). That's correct — don't
  force it; that machine is the source, not a consumer.

## Run

Run this as **one bash block** (keeps cwd + vars consistent; the gateway dies
mid-run but this script and your session are unaffected). Set `AGENT` to your
workspace if you're not invoking from it:

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
set -u
HERMIT="$HOME/hermit-ui"
AGENT="${AGENT:-$PWD}"
TPL="$HERMIT/apps/cli/template"
LOG="$AGENT/.update-hermit.log"; : > "$LOG"
say(){ echo "$@" | tee -a "$LOG"; }

[ -d "$HERMIT/.git" ] || { say "ABORT: no ~/hermit-ui git clone — install the gateway first."; exit 1; }
[ -d "$AGENT/.claude" ] || { say "ABORT: AGENT=$AGENT is not an agent workspace — set AGENT to your dir."; exit 1; }

cd "$HERMIT" || exit 1
before="$(git rev-parse HEAD)"
# A --depth 1 clone breaks merge-base/history ops; deepen once (no-op if already full).
git rev-parse --is-shallow-repository 2>/dev/null | grep -q true && { say "deepening shallow clone…"; git fetch --unshallow origin >/dev/null 2>&1; }
git fetch origin main 2>&1 | tail -2 | tee -a "$LOG"
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  say "ABORT: local HEAD has diverged from origin/main (unpushed work / dev source). Not touching."
  exit 1
fi
git merge --ff-only origin/main 2>&1 | tail -2 | tee -a "$LOG" || { say "ABORT: fast-forward failed (dirty tree?). Resolve manually."; exit 1; }
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  say "Gateway repo already up to date ($after). Refreshing skills anyway."
else
  say "Pulled $before → $after:"; git --no-pager log --oneline "$before..$after" | tee -a "$LOG"
fi

# ── Gateway: reinstall deps + restart only if gateway code/deps changed ──
if [ "$before" != "$after" ] && git diff --name-only "$before" "$after" | grep -qE '^(package-lock\.json|apps/gateway/|packages/)'; then
  if git diff --name-only "$before" "$after" | grep -qE 'package(-lock)?\.json'; then
    say "deps changed → npm install"; npm install --no-audit --no-fund 2>&1 | tail -3 | tee -a "$LOG"
  fi
  say "restarting gateway (delete + start + save)…"
  pm2 delete hermit-ui-gateway >/dev/null 2>&1
  pm2 start "$HERMIT/apps/gateway/ecosystem.config.cjs" 2>&1 | tail -2 | tee -a "$LOG"
  pm2 save >/dev/null 2>&1
  sleep 12
  if tail -40 "$HERMIT/apps/gateway/logs/out.log" 2>/dev/null | grep -q "\[control\] connected"; then
    say "gateway: control channel connected ✓"
  else
    say "gateway: control NOT confirmed in 12s — check 'pm2 logs hermit-ui-gateway'"
  fi
else
  say "gateway code/deps unchanged → no restart needed."
fi

# ── Refresh THIS agent's base skills + common scripts from the new template ──
for s in brave-search browser-automation cron loop update-hermit reshape-agent; do
  [ -d "$TPL/.claude/skills/$s" ] && { rm -rf "$AGENT/.claude/skills/$s"; cp -R "$TPL/.claude/skills/$s" "$AGENT/.claude/skills/$s"; }
done
mkdir -p "$AGENT/scripts/hooks"
cp -R "$TPL/scripts/." "$AGENT/scripts/" 2>/dev/null
chmod +x "$AGENT/scripts/"*.sh "$AGENT/scripts/hooks/"*.sh 2>/dev/null
say "refreshed base skills (brave-search/browser-automation/cron/loop/update-hermit/reshape-agent) + common scripts ✓"

# ── Surface template doc/settings drift (review manually — NOT auto-applied) ──
if [ "$before" != "$after" ]; then
  drift="$(git diff --name-only "$before" "$after" -- 'apps/cli/template/.claude/settings.json' 'apps/cli/template/AGENTS.md' 'apps/cli/template/CLAUDE.md' 'apps/cli/template/TOOLS.md' 2>/dev/null)"
  [ -n "$drift" ] && { say "— template docs/settings changed (compare against yours if you want them) —"; echo "$drift" | sed 's#apps/cli/template/#  template/#' | tee -a "$LOG"; }
fi
say "done. (new skills appear next turn; the dashboard reflects the refresh on the next agents tick.)"
```

## After running

Report to the user: which commits were pulled, whether the gateway restarted (and
reconnected), what was refreshed, and any "template doc changed" drift worth a
manual look. If the gateway didn't reconnect, say so plainly — it can be checked
with `pm2 logs hermit-ui-gateway` over ssh. The full run log is at
`<workspace>/.update-hermit.log` (handy if the chat stream gaps during the restart).
