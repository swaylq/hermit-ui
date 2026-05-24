# create-hermit-agent

> A scaffolder for **hermit agents** — Claude Code agents that live in their own directory, run in a tmux pane, and talk to you through the [hermit-ui dashboard](https://github.com/swaylq/hermit-agent) in your browser.

```bash
npx create-hermit-agent my-agent
```

## What you get

```
my-agent/
├── IDENTITY.md     who this agent is (name, persona, core values)
├── USER.md         who you are
├── AGENTS.md       workspace rules — image safety, MCP discipline, shell guards
├── TOOLS.md        local configs, API keys (by path), accounts
├── CLAUDE.md       bootstrap order Claude Code reads on every session
├── evolution/      the agent's slowly-accreted knowledge
│   ├── lessons.md  failure root-causes
│   ├── skills/     codified procedures
│   └── reflections/
├── scripts/        safe-image, tmux runners, browser launchers
├── start.sh        spawn the agent in a tmux session
├── restart.sh      respawn cleanly after wedges
└── .claude/        Claude Code project settings (permissions, MCP servers)
```

A hermit agent is a **Claude Code session that's home in this folder** — it reads these markdown files on every wake, remembers things in `evolution/`, and talks to its human through the hermit-ui dashboard's chat surface.

## Quickstart

### 1. Prerequisites

- **macOS or Linux.** Windows isn't supported (yet).
- **Node.js 18+** — for the CLI itself.
- **claude CLI** — install from <https://claude.com/claude-code>. Make sure `command -v claude` resolves.
- **tmux** — `brew install tmux` (mac) / `sudo apt install tmux` (debian/ubuntu) / etc.
- **sips** (mac, built-in) or **imagemagick** (linux) — used for image resize. Optional but recommended; without it, images > 2000px crash Claude sessions (see hermit-ui's `evolution/lessons.md` L4).

### 2. Scaffold

```bash
npx create-hermit-agent my-agent
```

Or non-interactive:

```bash
npx create-hermit-agent my-agent --yes \
  --persona "personal triage assistant" \
  --user sway \
  --dashboard-url https://dash.swaylab.ai
```

Flags:

| flag | description |
|---|---|
| `--persona "<line>"` | One-line description of focus. Lands in `IDENTITY.md`. |
| `--user "<name>"` | What the agent should call you. Defaults to `$USER`. |
| `--dashboard-url <url>` | hermit-ui dashboard the agent reports to. Default `http://127.0.0.1:4101`. |
| `--brave-key <key>` | Optional. Brave Search API key for the `brave-search` skill. |
| `--yes`, `-y` | Skip interactive prompts (requires the flags above). |

### 3. Start it

```bash
cd my-agent
./start.sh
```

This spawns `claude` in a detached tmux session named `claude-my-agent`. The agent boots, reads its workspace files, and waits.

### 4. Talk to it

Open your hermit-ui dashboard in a browser, pick `my-agent` from the sidebar, and start a chat. The dashboard's gateway pipes your message into a per-chat tmux pane running `claude` (separate from the `claude-my-agent` main pane). Replies stream back as the agent's JSONL transcript grows.

Paste / drag images into the composer to attach them — they're auto-resized to ≤2000px and arrive in the agent's prompt as `Read <local-cache-path>`.

## Editing the agent's mind

Hermit agents are designed to evolve. The CLI scaffolds a sensible default, but the markdown files are yours to rewrite:

- **`IDENTITY.md`** — persona, voice, boundaries. The agent re-reads this every session.
- **`USER.md`** — facts about you. The agent learns and appends here.
- **`TOOLS.md`** — APIs, accounts, integrations.
- **`evolution/lessons.md`** — append every "don't do that again" lesson with a one-paragraph postmortem.
- **`evolution/skills/<verb>.md`** — codified procedures the agent figured out (loosely modeled on [agentskills.io](https://agentskills.io)).

Inspired by [Hermes Agent's](https://github.com/NousResearch/hermes-agent-self-evolution) self-evolution pattern (read execution traces → identify _why_ failures happen → write reusable mutations), but markdown-first and human-curated — no DSPy, no embedding store. Just careful notes.

## Versus the old hermit-agent

Earlier versions (≤ v0.1.x) bridged the agent to **Telegram** — `npx create-hermit-agent` walked you through bot tokens and chat IDs. **v1.0+ removes that path entirely.** Chat happens in the hermit-ui dashboard, a self-hosted web UI you run alongside the gateway on your own machine. Why:

- No bot token gymnastics, no Telegram API rate limits.
- Image upload / inline rendering / multi-session chat all work natively.
- Long-running tmux session per chat means slash commands, sub-agents, `/compact`, plan mode — every Claude Code feature is available, not just the subset Telegram's plugin exposed.
- Chat traffic bills against Claude Max's Interactive bucket (the large one), not the Agent SDK bucket — see hermit-ui's `evolution/lessons.md` L1 for the math.

If you need Telegram, stay on v0.1.x or pin `create-hermit-agent@0.1`.

## Repo

<https://github.com/swaylq/hermit-agent>

## License

MIT — see `LICENSE`.
