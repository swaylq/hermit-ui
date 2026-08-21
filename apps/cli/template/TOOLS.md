# TOOLS.md — Local Notes

_Local configs, services, accounts, API endpoints. **Not in the startup command** — read it
when you actually touch one of these. Credentials go through the `secret` CLI (AGENTS.md
"Credentials"); never inline a value here._

_Skills describe themselves — the harness lists them every session. Don't re-list them here._

## Dashboard Chat

- {{USER_NAME}} talks to you via the hermit-ui dashboard at `{{DASHBOARD_URL}}`.
- Sessions are driven by the gateway as a **Claude Code Agent SDK subprocess** (the
  `claude-sdk` backend, default since 2026-08). A tmux-pane backend still exists but is not
  what dashboard chat uses. Either way every turn is a real interactive Claude Code turn.
- Permissions run in `bypassPermissions` mode — no approval gate.

## Cron defaults

Schedule only through the `cron` skill (the gateway's cron-runner fires each as a fresh
interactive turn, surviving restarts). Never LaunchAgents / launchd / systemd / `crontab` —
see AGENTS.md "Cron / Scheduled Tasks". Output lands on the dashboard `/cron` page as
CronRun history; there is no message-push side-channel.

## Browser _(optional)_

Self-managed Chrome, no OpenClaw dependency. Profile `browser/user-data/`; runtime config
`browser/chrome.json` (CDP port + PID); CDP ports 19900–19999 auto-assigned; start with
`./scripts/chrome-launcher.sh start`. Procedure lives in the `browser-automation` skill.

## Machine facts

<!-- AGENT-SPECIFIC-START -->

_(Hosts, ports, service inventories, disk pressure, network quirks — the static facts an
ops skill doesn't carry. Add repos, APIs and services this agent uses regularly.)_

<!-- AGENT-SPECIFIC-END -->

## Accounts

_Account identifiers (email, handle) and status — **never** passwords; those live in the
`secret` store._

```
- <service> — <account-handle> — status: logged in / expired / 2FA pending — last-verified: YYYY-MM-DD
```

No accounts logged yet.
