# {{AGENT_DISPLAY_NAME}}

{{USER_NAME}}'s **{{PERSONA}}** hermit agent. Runs locally on Claude Code, talks to {{USER_NAME}} via the hermit-ui dashboard.

## What's in this directory

| file | what it's for |
|---|---|
| `CLAUDE.md` | bootstrap order Claude Code reads on every session — leave it alone |
| `IDENTITY.md` | who this agent *is* (name, persona, core values). **Edit to tailor.** |
| `USER.md` | who {{USER_NAME}} is. Fill in as you learn. |
| `AGENTS.md` | workspace rules (memory, image safety, MCP discipline). Safe defaults shipped. |
| `TOOLS.md` | local configs, API keys (by path), accounts |
| `evolution/` | your slowly-accreted narrative — lessons learned the hard way, weekly reflections (codified *procedures* live in `.claude/skills/`) |
| `scripts/` | safe-image, tmux runners, browser launchers, etc. |
| `start.sh` | spawn the agent in a tmux session |
| `restart.sh` | respawn after MCP changes / wedges |
| `.claude/settings.local.json` | dashboard URL + (optional) Brave key + permission allowlist |

## First run

```bash
cd {{AGENT_DIR}}
./start.sh
```

That launches `claude` in a detached tmux session named `claude-{{AGENT_NAME}}`. The agent boots, reads its IDENTITY/USER/AGENTS/TOOLS files, and waits for messages.

## Talking to {{AGENT_DISPLAY_NAME}}

Open **{{DASHBOARD_URL}}/chat** in a browser. Pick `{{AGENT_NAME}}` from the sidebar (or create a new session against it). Your message → dashboard → local gateway → `tmux send-keys` into a per-chat tmux pane running `claude`. Reply streams back as the JSONL transcript grows.

Paste / drag images into the composer — they're resized to ≤2000px, cached locally, and arrive in {{AGENT_DISPLAY_NAME}}'s context as a `Read <path>` command.

## Watching it work

```bash
tmux attach -t claude-{{AGENT_NAME}}   # main pane
tmux ls | grep hermit-                 # per-chat panes (one per dashboard session)
```

Detach with `Ctrl-b d` — don't `Ctrl-c` or you kill the agent.

## When something's wrong

```bash
./start.sh --status                    # is the session up?
./restart.sh $(cat agent.pid)          # respawn after MCP add/remove, wedges
tail -f restart.log                    # see what happened
```

If the dashboard says the agent is "down", check `agent.pid` against `ps -p $(cat agent.pid)`. If it's dead, `./start.sh` again.

## Editing the agent's mind

- Tweak persona / voice → `IDENTITY.md`. Tell {{USER_NAME}} when you change it (you wrote that rule, follow it).
- Add a new fact about {{USER_NAME}} → `USER.md`.
- New API integration, account, or tool → `TOOLS.md`.
- Learned a "don't do that again" → append to `evolution/lessons.md`.
- Codified a multi-step procedure → a real skill at `.claude/skills/<verb>/SKILL.md` (tag `source: evolution` in the frontmatter so it shows as self-evolved).

Changes take effect on the **next** turn — Claude Code re-reads these files at every session boot, and you can also force a re-read with `/compact` or `./restart.sh`.

## Scaffolded by

[`create-hermit-agent`](https://github.com/swaylq/hermit-agent) — `npx create-hermit-agent` makes another one of these.
