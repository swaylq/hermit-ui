---
name: loop
description: Run a recurring task inside THIS chat session — every iteration is a turn in this conversation, so its result streams back here and the dashboard shows a live loop card above the composer. Use when the user says "循环", "每 X 分钟/小时 做 Y", "持续迭代", "反复优化", "loop on X", "keep doing X until <cond>", "iterate toward <goal>", "自调步循环", or "开启循环任务". For fire-and-forget scheduled routines (cron expression, durable across restart) use the `cron` skill instead.
user_invocable: true
---

# Loop — In-Conversation Recurring Tasks

A loop repeats a task on a cadence; **every iteration runs as a turn in the current chat session**, so its output lands in this conversation automatically and the hermit-ui dashboard renders a live loop card above the composer. Loops are session-scoped — they ride this Claude session and stop on restart. For tasks that must survive restart, that's the `cron` skill / system crontab, not this.

## When this skill fires

Natural language only — there is no `/loop` slash command in the dashboard anymore. Trigger on:

- 每 N 分钟/小时 + 做某事 → fixed-interval loop
- 持续迭代 / 反复优化 / keep doing X → loop toward a goal
- 循环直到 <条件> / loop until <cond> → until-condition loop
- 自调步 / 你来定节奏 / let me decide the cadence → self-paced loop (you choose each delay)
- 开启循环任务 (the dashboard's suggestion seeds the composer with a template) → fill in interval + task + stop condition

## Required inputs — ask once if missing

1. **Task** — what to do each iteration. Concrete and verifiable.
2. **Cadence** — fixed interval (每 30 分钟), self-paced (you decide), or until-driven.
3. **Stop condition** — a goal/terminus, or "until I say stop". A loop with no terminus runs forever; confirm that's intended.

If the user names a topic but no terminus: ask 目标是什么？需要一个能验证已达成的具体终点。

## Mechanism (session-scoped)

Pick by cadence:

- **Fixed interval** → `CronCreate` with `recurring: true` and a 5-field expr at an off-tick offset (`:07`, `:23`, `:43` — avoid `:00`/`:30`). Each fire re-invokes you with the iteration prompt below.
- **Self-paced** → `ScheduleWakeup`: each iteration re-arms the next wakeup with a delay you choose. One self-paced loop at a time.
- **Until <cond>** → either mechanism; each iteration checks the condition and stops itself when met.

Use the CronCreate/wakeup job id as the loop's `id`.

### The iteration prompt (what you schedule)

Every iteration prompt MUST do, in order:

```
Read silently first: ./IDENTITY.md ./USER.md ./AGENTS.md ./TOOLS.md ./MEMORY.md ./memory/<today>.md (if present).

Then do this iteration of the loop: <THE TASK>

Then SELF-TEST this iteration before reporting — run the build / test / metric / check appropriate to the work and confirm it actually passed. On failure: roll back or record the failure honestly; NEVER report success you didn't verify. This self-test is mandatory every iteration.

Then:
1. Update ./.loop-state.json (see "State file"): bump this loop's runCount, set lastRunAt + a one-line lastResult. Leave `schedules` untouched.
2. Append a one-line result to ./memory/<today>.md.
3. Reply with ONE short report — it STREAMS TO THIS CHAT — starting with the marker line:
   ↻ loop `<id8>` · run <N> — <one-line result, incl. the self-test outcome>
4. If <stop condition> is met: set this loop's status to "done", CronDelete the job (or stop re-arming), and say so in the reply.
```

Keep each iteration's reply short — it's a chat message, not a report dump. Detail goes to daily memory. The leading `↻ loop` marker is what makes loop output recognizable in the conversation.

## State file — `./.loop-state.json`

The dashboard's loop card reads `<agent_dir>/.loop-state.json` every snapshot tick (~30s) — your cwd IS that dir. **You own the `loops` array; the `cron` skill owns `schedules`.** Never blind-overwrite: read the file, change only `loops`, write it back preserving `schedules`.

```json
{
  "loops": [
    {
      "id": "<job-id>",
      "kind": "interval | self-paced | until",
      "schedule": "每 30m | self-paced | until <cond>",
      "prompt": "<one-line task summary>",
      "status": "running | done | stopped",
      "runCount": 0,
      "createdAt": "<iso>",
      "lastRunAt": null,
      "lastResult": null
    }
  ],
  "schedules": [],
  "updatedAt": "<iso>"
}
```

If the file is absent, create it with `schedules: []`. If it exists, merge (keep `schedules`).

## Creating a loop

1. Confirm task + cadence + stop condition (ask once if unclear).
2. Create the mechanism (above); capture the job id as the loop id.
3. Read-merge-write `./.loop-state.json`: add the loop entry (`status: "running"`, `runCount: 0`, `lastRunAt`/`lastResult` null).
4. Reply (streams to chat) with: task, cadence, stop condition, loop id, and the honest note — "session-scoped — 重启即停。每轮结果会发到这个对话。要跨重启持久就用 cron skill / 系统 crontab。"

## Listing loops

Read `./.loop-state.json` `loops` (cross-check with `CronList`) and format: id, cadence, status, runCount, last result.

## Stopping a loop

User says "停 loop X" / "stop the loop" / "停掉循环":

1. `CronDelete` the job (or stop re-arming a self-paced loop).
2. Read-merge-write `./.loop-state.json`: set that loop's `status` to `stopped` (or drop the entry).
3. Confirm in your reply.

## Guardrails

- **Verify each iteration.** Build / test / metric appropriate to the work. On failure: rollback + record honestly; never pretend success. 3 consecutive failures → pause and ask the user how to proceed.
- **No file-count limit.** Quality over minimalism. Keep each iteration a coherent theme; don't bundle unrelated work.
- **One self-paced loop at a time.** Multiple fixed-interval loops are fine.
- **Session-only.** CronCreate dies on restart (the harness ignores `durable: true`); a self-paced loop's wakeups die with the session too. Say so at creation.
- Iterations fire only while the REPL is idle; they don't interrupt an active turn.
