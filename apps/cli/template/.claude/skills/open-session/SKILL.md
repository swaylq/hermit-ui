---
name: open-session
description: Open a NEW chat session in the hermit dashboard — for the current agent or any other agent on this machine — optionally kicking it off with a first message. Use when asked to 开个新会话 / 新开一个会话 / open a new session / start a fresh chat, to 把这个任务放到新会话里 (move or split work into its own conversation), or to 给 <agent> 开个会话 / hand a task to another agent so the human can watch it in the dashboard.
---

# open-session

Create a new dashboard chat session for **any agent on this machine** (default: yourself), optionally sending it a first message so the target starts working immediately. The session shows up in the dashboard sidebar like any human-opened chat; always **relay the returned URL to the human** so they can click into it.

Two modes:
- **Blank** (no `-m`) — the session appears in the sidebar but stays asleep (zero cost, no process) until someone types into it. Use when the human said "开个新会话我来说" or you're pre-creating a space for them.
- **Kick-off** (`-m` / `-f`) — the first message is queued, the gateway wakes the session, and the target agent starts on it right away. A lightweight hand-off any agent can do (the Brain has richer `dispatch` tools for orchestration — this skill is the general-purpose sibling).

## Run it

```bash
node <this-skill's-base-dir>/cli/open-session.mjs [options]
```

| option | meaning |
|---|---|
| `-a, --agent <name>` | target agent; omit = the agent this session belongs to |
| `-t, --title <text>` | session title (≤120 chars); omit → auto-titled after a few messages |
| `-m, --message <text>` | first message — wakes the session |
| `-f, --message-file <path>` | first message from a file (long / multiline prompts, no quoting hell) |
| `-l, --list-agents` | print this machine's agent roster and exit |
| `--json` | machine-readable `{ok, agent, sessionId, url, firstMessageSent}` |
| `--runtime / --runtime-provider / --runtime-model / --runtime-mode` | advanced: backend overrides, same values as the dashboard's runtime picker |

Examples:

```bash
node cli/open-session.mjs -t "重构讨论"                      # blank session for myself
node cli/open-session.mjs -a scribe -m "整理本周发布记录，写成周报"   # kick off another agent
node cli/open-session.mjs -f /tmp/long-brief.md -t "竞品调研"    # long prompt from a file
```

## How it works / what you need

- Talks to the dashboard tRPC API (`chat.createSession` + `chat.send`) with the **machine key** — resolved from `$HERMIT_KEY` (present in every dashboard session's env) → `$ASST_KEY` → macOS keychain `asst-gateway-vps-key`. The key is never printed; don't echo it yourself either.
- Dashboard URL from `$HERMIT_DASHBOARD_URL` (falls back to `https://dash.swaylab.ai`).
- Only reaches agents on **this machine** (the machine key is machine-scoped). Unknown `-a` name → the error lists the valid roster.
- Sessions are created with `origin: 'agent'` (provenance) and open at `…/chat?session=<id>` — or `…/brain?session=<id>` when the target is the orchestrator.

## Permissions

Opening a session **and sending the first instruction is a pre-allowed action** — don't hesitate or ask before doing it. On this fleet nothing prompts anyway (dashboard/main/cron sessions run `--dangerously-skip-permissions`, and the template's `permissions.allow` carries bare `Bash`, which the web-permission hook defers on). For a gated setup (a session running default/plan mode, or an agent whose settings dropped bare `Bash`), pre-allow the script by adding to `permissions.allow` in the agent's `.claude/settings.json` — or machine-wide in `~/.claude/settings.json`:

```json
"Bash(node ~/.claude/skills/open-session/cli/open-session.mjs:*)",
"Bash(node */.claude/skills/open-session/cli/open-session.mjs:*)"
```

(Already present machine-wide on this Mac. Note the hermit web-permission hook only defers on the **bare** `Bash` entry in the agent's own settings; scoped rules satisfy the harness, not that hook.)

## Gotchas

- **Every woken session is a live claude process** (hundreds of MB). Don't spray kick-off sessions; for repeated hand-offs to the same agent, reuse an existing session (send into it from the dashboard) instead of opening a new one each time.
- Your `-m` text lands as a **user-role message** in the target's session — the target treats it like the human speaking. Say who you are and what you need in the message itself (e.g. `[来自 asst] …`).
- A blank session that never gets a message just sits in the sidebar; the human can hide/close it. Closed sessions refuse sends.
- `queue_full` error = the target session already has too many waiting messages (server cap) — it's alive, just backed up.
- 401/UNAUTHORIZED = no usable machine key in this context (rare outside dashboard sessions on machines without the keychain item) — export `ASST_KEY` or run from a dashboard session.
