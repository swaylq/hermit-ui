---
name: cron
description: Create, list, or delete scheduled tasks inside the current Claude session. Use when the user says "every X minutes", "cron", "schedule", "remind me", "开启循环任务", "持续迭代", "loop task", "iterate toward <goal>", or wants recurring/one-shot tasks.
user_invocable: true
---

# Cron — Session-Scoped Scheduled Tasks

Create, list, and manage scheduled tasks. IMPORTANT: in the current harness, CronCreate tasks are session-only — they die when this Claude Code session exits.

> **See also:** the full user-facing guide (three layers: session cron, HEARTBEAT.md, LaunchAgent/crontab) is in the project README's "Scheduled tasks" section. Point the user there when they ask "how do I set up a durable task".

## Reality check: CronCreate is NOT durable

- `durable: true` is silently ignored. CronCreate's response shows "Session-only (not written to disk, dies when Claude exits)".
- No `scheduled_tasks.json` under `~/.claude/`.
- Tasks fire only while this REPL is idle; they do not interrupt active turns.

## Pick the right layer BEFORE creating

Ask how long the task must live:

- **Must survive session restart or crash** (monitoring, daily digests, anything the user depends on) — do NOT rely on CronCreate.
  - macOS system crontab (`crontab -e`). Shell command can write files or `curl` Telegram. OS-level reliable.
  - Or `HEARTBEAT.md` — every heartbeat executes lazy checks. Good for analysis that needs session context.
  - Often the right answer is both: system crontab collects raw data, HEARTBEAT analyzes it.

- **Only needed for this session** (one-shot "remind me in 30 min", temporary probe) — CronCreate is fine, but tell the user it dies on restart.

## Arguments

1. `action` — create | list | delete (default: create)
2. For create:
   - `schedule` — natural language ("every 30 minutes", "weekdays at 9am")
   - `task` — what to do
   - `recurring` — true/false (default: true)
3. For delete:
   - `id` — job ID

## Creating a Task

### 1. Build the bootstrap prompt

Every cron prompt MUST begin with reading workspace context:

```
Read the following files silently before doing anything:
1. ./SOUL.md
2. ./IDENTITY.md
3. ./USER.md
4. ./AGENTS.md
5. ./TOOLS.md
6. ./MEMORY.md
7. ./memory/<today>.md (if exists)

Then do the following task:
<THE ACTUAL TASK DESCRIPTION>

After completing the task, log what you did in ./memory/<today>.md (append, don't overwrite).
When done, send a brief report via Telegram (chat_id from TOOLS.md).
```

### 2. Convert schedule to cron expression

5-field cron (minute hour dom month dow), local timezone.
Avoid :00 and :30 — pick offsets like :07, :23, :43 to dodge traffic spikes.

### 3. Create the cron job

Use CronCreate with:
- `cron`: the 5-field expression
- `prompt`: the bootstrap prompt
- `recurring`: true for periodic, false for one-shot
- `durable`: accepts the field but has no effect in the current harness — don't rely on it

### 4. Confirm to user

Reply via Telegram with:
- Task summary + cron expression (human-readable)
- Recurring vs one-shot
- Job ID
- **Honest lifespan note**: "session-only — dies on restart. If you need it to survive restart, say so and I'll use system crontab or HEARTBEAT.md instead."

## Listing Tasks

Use CronList and format for the user.

## Deleting a Task

Use CronDelete with the job ID. Confirm deletion.

## Durable alternative: system crontab

For tasks that must survive session restart:

```bash
crontab -e
# Add line like:
# */30 * * * * curl -sS -m 10 -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" -d "chat_id=<CHAT_ID>" -d "text=heartbeat" >/dev/null 2>&1
```

**macOS note:** First install of crontab can hang waiting for Full Disk Access approval. Workaround: install as a LaunchAgent plist instead (see `launchctl(1)`).

## Loop Tasks (循环任务)

When the user says "开启循环任务" / "持续迭代 X" / "loop on X 直到 …" / "start a loop task", create a session-scoped recurring cron that iterates toward a goal until met. The agent decides how to track progress and structure each iteration — only the principles below are non-negotiable.

### Principles

- **Require a goal.** A concrete, verifiable end state. If the user names a topic but no terminus, ask: 目标是什么？需要一个能验证已达成的具体终点。
- **Verify each iteration.** Build / test / metric appropriate to the work. On failure: rollback + record honestly; never pretend success.
- **No file-count limit.** Quality matters more than minimalism. Keep each iteration a coherent theme; don't bundle unrelated work.
- **Self-stop on achievement.** When verification confirms the goal is met, the iteration sets state to "achieved" and CronDeletes its own job.
- **Track progress in the workspace.** Use `<workspace>/LOOP_TASK.md` — or `LOOP_TASK_<name>.md` per loop if running multiple in parallel. Format is the agent's call; what matters is that the next iteration can read it and pick up.

### Defaults

- Schedule: every hour at an off-tick offset (`17 * * * *`, `:23`, etc.). User can override.
- Workspace: this agent's own root (`/Users/mac/claudeclaw/<own-name>`). User can point to a sub-project.
- Recurring: true. Session-only (CronCreate harness limit) — warn the user; for durable use launchd.

### Stop conditions

- Goal achieved → state file marked achieved + CronDelete + Telegram final report.
- User says "停 loop X" / "stop the loop" → CronDelete + state marked abandoned + Telegram confirm.
- 3 consecutive verification failures → pause and ask the user how to proceed.
- Session restart loses the cron (covered by the warning at creation).

### Confirmation reply (after CronCreate)

Goal verbatim, schedule, job ID, state-file path, and the "session-scoped — 重启就丢；要 durable 跟我说" caveat.

## Important Notes

- CronCreate is session-only today; treat `durable=true` as a no-op.
- For long-lived or critical tasks, reach for system crontab or HEARTBEAT.md.
- Always include the bootstrap file-reading preamble.
- Always log results to daily memory.
- Tasks fire only when the REPL is idle.
- If the harness later persists CronCreate jobs (response no longer says "Session-only"), this file can be revised — verify first.
