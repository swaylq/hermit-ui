# TOOLS.md — Local Notes

_Technical configs, tool settings, accounts. Credentials are handled by the `secret` CLI (see AGENTS.md) — never inline values._

## Dashboard Chat

- {{USER_NAME}} talks to you via the hermit-ui dashboard at `{{DASHBOARD_URL}}`.
- Messages arrive through the local gateway: it spawns a tmux pane running `claude`, sends `{{USER_NAME}}`'s text via `tmux send-keys`, and tails your JSONL transcript to stream your reply back to the browser.
- Every chat turn is a real interactive Claude Code turn — slash commands, sub-agents, `/compact` all work. Treat the dashboard like a remote terminal.

## Skills

- **restart** — restart this Claude Code session via tmux respawn.
- **cron** — create DURABLE scheduled tasks (registered on the dashboard `/cron` page; the gateway's cron-runner fires each as a fresh interactive Claude turn in your dir, surviving restarts). This is the ONLY way to schedule — **never** LaunchAgents / launchd / systemd-user timers / `crontab`.
- **loop** — repeat a task each turn in THIS chat session (session-scoped; stops on restart). For anything that must survive restart, use `cron`.
- **brave-search** _(optional; requires API key)_ — web/news/image/video search via Brave Search API.
- **browser-automation** _(optional)_ — self-managed Chrome + Playwright CDP. Explore with `mcp__playwright-browser__*`, record to `scripts/browser/<verb>-<target>.js`, replay via `scripts/browser-lock.sh run <script>`.
- **provision-agent** — scaffold a new sibling hermit agent via `npx create-hermit-agent`.

### Cron defaults

- Schedule via the `cron` skill only — the gateway's cron-runner runs each fire as a fresh interactive Claude turn (no manual `with-timeout.sh` / launchd wrapping). Keep each cron strictly on-prompt (no human in the loop) and self-test every run before reporting.
- Cron output lands on the dashboard `/cron` page (CronRun history) — review it there; there's no message-push side-channel.

## Browser _(optional)_

- Self-managed Chrome instance, no OpenClaw dependency.
- Profile: `browser/user-data/`
- Runtime config: `browser/chrome.json` (CDP port, PID)
- CDP port range: 19900–19999 (auto-assigned).
- Start: `./scripts/chrome-launcher.sh start`

## APIs

<!-- AGENT-SPECIFIC-START -->

### Brave Search API _(optional)_

The `brave-search` skill needs `BRAVE_API_KEY` — keep it in the `secret` store (`secret list` to confirm). Base URL `https://api.search.brave.com/res/v1`, auth header `X-Subscription-Token`.

_(Add repos, APIs, services this agent uses regularly below.)_

<!-- AGENT-SPECIFIC-END -->

## Accounts

_Per-site account identifiers (email, handle) and status — NEVER passwords (those live in the `secret` store)._

No accounts logged yet.

Format suggestion:

```
- <service> — <account-handle> — status: logged in / expired / 2FA pending — last-verified: YYYY-MM-DD
```
