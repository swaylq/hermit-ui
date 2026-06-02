---
name: cron
description: Schedule a DURABLE recurring task that runs on a fixed interval and is managed on the dashboard /cron page. Use when the user says "定时任务", "每天/每周/每隔 N 分钟 做 X", "cron", "schedule", "提醒我定时", "routine", or wants a recurring task that survives restarts. For an in-conversation loop whose every result streams back into THIS chat, use the `loop` skill instead.
user_invocable: true
---

# Cron — Durable Scheduled Tasks

A cron is a recurring task the **gateway** fires on a fixed interval — every fire is a fresh `claude` turn (via tmux) in this agent's directory, and its result is recorded on the dashboard **`/cron` page** (it is NOT streamed into this chat). Crons are **durable**: they live in the database and the gateway keeps firing them across session / gateway restarts.

> In-conversation loops whose results should appear in THIS chat (你看着它一轮轮做) are the **`loop` skill**, session-scoped. This `cron` skill is for set-and-forget scheduled tasks you check on the /cron page.

## When this fires

Natural language (there is no `/schedule` slash command). Trigger on:
- 每天 / 每周 / 每隔 N 分钟·小时 + 做某事
- 定时任务 / 定时跑 / scheduled / cron / routine
- 提醒我每天… / 每隔一段时间检查…

## Required inputs — ask once if missing

1. **Task** — what to do each run (becomes the cron's prompt). Make it self-contained.
2. **Interval** — how often (每 N 分钟 / 小时 / 天).
3. **Jitter (optional, encouraged for periodic checks)** — a ± random float on the fire time so repeated runs don't hit external services on the exact same tick. Suggest e.g. ±10% of the interval.

## How to create

Call the MCP tool — it writes the cron to the DB for THIS agent and the gateway picks it up next tick:

```
mcp__hermit__cron_create({
  prompt: "<the task>",
  intervalMinutes: <N>,          // 30 = every half hour, 1440 = daily
  jitterMinutes: <M>,            // optional ± window, default 0
  title: "<short label>"         // optional, shown in the /cron list
})
```

Then confirm to the user: the interval, the jitter (if any), and that it's now on the dashboard **/cron page** where they can see each run's result, edit the schedule / prompt, or stop it. Note results are recorded there (not posted into this chat) — if they want the results here every time, that's the `loop` skill.

## Listing / stopping

- `mcp__hermit__cron_list()` → this agent's crons (id, interval, status). Use to report, or to find an id.
- `mcp__hermit__cron_delete({ id })` → remove one (get the id from cron_list). Use when the user says 停掉 / 删除 that scheduled task.

The user can also manage everything (enable/disable, edit interval + prompt, run-now, delete) directly on the **/cron page**.

## Notes

- Each fire is **independent** — a fresh claude session, no memory carried between runs. Put everything the run needs into the prompt; the agent reads its own CLAUDE.md for workspace context on boot.
- Interval minimum is 1 minute.
- **Durable**: survives restarts (gateway-driven). That's the key difference from the session-scoped `loop` skill.
