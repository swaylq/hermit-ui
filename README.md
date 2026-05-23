# hermit-ui

Web UI + local gateway for hermit-agent. Multi-agent control, chat, usage, observability — all in a browser tab.

## What this is

`hermit-ui` is the home for everything that used to live across `asst/dashboard`, `asst/gateway`, and `hermit-agent/` (the npm scaffold). Reunified into one monorepo so a single change can ship through to all three at once.

Replaces the Telegram-based chat surface that `create-hermit-agent` used to scaffold. Chat now happens in the dashboard, via the gateway, attached to a real interactive `claude` running inside a long-lived tmux pane — same Interactive billing bucket as a terminal session.

## Layout

```
hermit-ui/
├── apps/
│   ├── dashboard/   # Next.js — web UI, deployed to dash.swaylab.ai
│   ├── gateway/     # Mac-local tsx — collects state, drives tmux panes
│   └── cli/         # create-hermit-agent — npm-published scaffold
├── packages/
│   ├── proto/       # shared zod schemas + tRPC contract
│   ├── tmux-driver/ # tmux session pool + send-keys + JSONL watcher
│   └── ui/          # shared design system
├── template/        # agent skeleton (copied by the CLI)
├── agents/          # test workspaces (NOT sway's real asst agent)
├── evolution/       # project-level lessons distilled from long-task failures
└── docs/
```

## Why "hermit-ui" not "hermes"

Hermes Agent is a separate OSS project (Nous Research, https://hermes-agent.org/). Hermit-agent (yours, https://github.com/swaylq/hermit-agent) is a different thing — name kept to avoid collision.

## Evolution

`evolution/` holds project-level lessons learned the hard way. Failure root-causes get distilled into one-page markdown notes here so future iterations don't repeat them. Modeled loosely on Hermes' GEPA pattern (read execution traces → identify _why_ failures happen → produce reusable mutations), but human-curated and markdown-first — no DSPy, no embedding store. The seed entries are in `evolution/lessons.md`.

Per-agent evolution (the agent's own self-improvement notes, persona drift, learned skills) lives under each agent's workspace at `<agent>/evolution/`, not here.
