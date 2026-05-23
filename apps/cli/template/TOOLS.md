# TOOLS.md — Local Notes

_Technical configs, API keys (by path, not value), tool settings, accounts._

## Dashboard Chat

- {{USER_NAME}} talks to you via the hermit-ui dashboard at `{{DASHBOARD_URL}}`.
- Messages arrive through the local gateway: it spawns a tmux pane running `claude`, sends `{{USER_NAME}}`'s text via `tmux send-keys`, and tails your JSONL transcript to stream your reply back to the browser.
- Every chat turn is a real interactive Claude Code turn — slash commands, sub-agents, `/compact` all work. Treat the dashboard like a remote terminal.

## Skills

- **restart** — restart this Claude Code session via tmux respawn.
- **cron** — create session-scoped scheduled tasks. Reminder: CronCreate's `durable=true` is currently a no-op; for tasks that must survive restart, use macOS LaunchAgents or Linux systemd-user timers.
- **brave-search** _(optional; requires API key)_ — web/news/image/video search via Brave Search API.
- **browser-automation** _(optional)_ — self-managed Chrome + Playwright CDP. Explore with `mcp__playwright-browser__*`, record to `scripts/browser/<verb>-<target>.js`, replay via `scripts/browser-lock.sh run <script>`.
- **provision-agent** — scaffold a new sibling hermit agent via `npx create-hermit-agent`.

### Cron defaults

- Long-running tasks should call `scripts/with-timeout.sh 1200` (20 min ceiling).
- Cron tasks should report back to {{USER_NAME}} when done — push to the dashboard via `scripts/dashboard-push.sh "<message>" [type]`.

## Browser _(optional)_

- Self-managed Chrome instance, no OpenClaw dependency.
- Profile: `browser/user-data/`
- Runtime config: `browser/chrome.json` (CDP port, PID)
- CDP port range: 19900–19999 (auto-assigned).
- Start: `./scripts/chrome-launcher.sh start`

## APIs

<!-- AGENT-SPECIFIC-START -->

### Brave Search API _(optional)_

If `env.BRAVE_API_KEY` is set in `.claude/settings.local.json`, the `brave-search` skill is usable.

- Base URL: `https://api.search.brave.com/res/v1`
- Auth: `X-Subscription-Token` header
- Key: _(set during init or add later — see `.claude/settings.local.json`)_

_(Add repos, APIs, services this agent uses regularly below.)_

<!-- AGENT-SPECIFIC-END -->

## Accounts

_Per-site account identifiers (email, handle) and status — NEVER passwords. Passwords go in the browser profile or a password manager._

No accounts logged yet.

Format suggestion:

```
- <service> — <account-handle> — status: logged in / expired / 2FA pending — last-verified: YYYY-MM-DD
```
