# Loop and cron were one feature described twice

**Status:** implemented 2026-08-26.
**Change:** the session-scoped `loop` is deleted. Every repeating task is a `Cron`.

## What was actually different

Nothing that mattered, by the end. The two started far apart and converged without anyone
deciding they had:

| | loop (deleted) | cron (kept) |
|---|---|---|
| Where it lived | `<agent_dir>/.loop-state.json` → snapshot tick → `ChatSession.loopState` | a `Cron` row in Postgres |
| Who fired it | the Claude Code harness inside one live session (`CronCreate` / `ScheduleWakeup`) | the gateway's `cron-runner`, every 15s |
| Survives a restart | no | yes |
| Shows on `/cron` | no | yes |
| Reports into the chat | yes | **yes, since the `reportSessionId` migration (2026-07-29)** |
| Run history | grep the conversation for a `↻ loop` marker line | `CronRun` rows |

That fifth row is the one that collapsed the distinction. Once a cron posted its report into
the chat that created it, the honest summary of "loop" became: *a cron that forgets everything
when you restart, and that you cannot find afterwards.*

The cost of keeping both was not the code. It was that every agent had to choose between two
skills on every 「每 30 分钟…」, the two SKILL.md files each ended with a paragraph pointing at
the other, and the cron one had been factually wrong for a month (it still claimed its results
were "NOT streamed into this chat").

## What loop could do that cron could not

Two things, both now on cron:

**1. Stop when the goal is met.** A loop checked its own stop condition and deleted its job. A
cron run cannot: an ordinary agent's cron runs **headless** — no hermit MCP — deliberately, so
the dashboard machine key is never widened into an unattended process (`cron-runner.ts`,
`cronPaneEnv`). So the signal goes out through the only channel a headless run has: its own
output.

A run that has verified its finish line ends its reply with a line containing exactly:

```
CRON_DONE
```

**2. Choose its own next interval.** Same channel:

```
CRON_NEXT 45
```

### How the markers are read

`parseRunMarkers(output)` in `apps/gateway/src/cron-runner.ts`, called in `fireInner`'s
reporting tail. Three details that are load-bearing:

- **Before `capOutput`, not after.** `capOutput` keeps the first 32,768 characters of a run's
  output — the head, because cron authors are told to lead with the outcome. A marker at the
  end of a long report would be truncated away before anyone could read it.
- **Only the last 5 non-empty lines are examined.** A report that quotes `CRON_DONE` while
  explaining it must not end the cron.
- **Marker lines are stripped** from the stored output, so the chat report and `/cron` show
  the agent's prose and nothing else.

The gateway then posts `{ done, nextIntervalSec }` alongside the finish, and
`app/api/sync/cron-run/route.ts` applies them: `done` → `enabled = false` + `doneAt = now()`;
`nextIntervalSec` → new `intervalSec` **and a recomputed `nextFire`** (the `start` phase already
stamped one from the old interval, so without the recompute the change would land one run late).

### Why `doneAt` is a column and not just `enabled = false`

Because "it reached its goal" and "a human switched it off" are the same row otherwise, and the
UI has to say 已完成 rather than 已暂停. Cleared on any re-enable, so a revived cron is not
labelled done forever.

## What a cron run remembers

Nothing — each fire is a fresh claude that never sees the conversation. That was already true
and is a feature (a daily job cannot grow a chat's context without bound), but it is the one
thing an iterating task has to design around, so the skill mandates a progress file:

```
<work dir>/PROGRESS.md
```

read at the top of the prompt, written before the run replies. This is strictly more durable
than the loop's in-session context, which vanished on restart.

## The notification that had to move with it

A loop round pushed a notification every time; a *successful* cron pushed nothing —
`/api/sync/cron-run` only pushed `BAD_STATUS`, on the reasoning that a fleet's worth of quiet
daily crons is noise. Both were right about their own case, and deleting the loop without
noticing would have silently ended per-round notifications for anyone watching a task.

So `loopRoundEvent` became `cronReportEvent`, fired when a run **succeeds and reports into a
session**. It keeps the two properties the loop event was built for: it is not held (the report
IS the conclusion — there is nothing left of the turn to wait for), and it has its own collapse
key (`<sessionId>:cron`), so ordinary chatter cannot evict it from the lock screen. Failures
still go through `cronEvent`, which points at `/cron` where the run log that explains them
lives. A cron with no `reportSessionId` still pushes nothing on success, which was the original
point.

The `'loop'` push kind is gone; both events are `'cron'`. `push/index.ts` tells them apart by
`sessionId`, which only the report event sets.

## One thing genuinely lost

`sessionStatusView`'s `unreadLoopRound` override is deleted, not ported. It let an unread round
turn a session's dot red while a background task was still ticking — the amber branch means
"the reply is still to come", and a round report was the reply. A cron runs in a throwaway pane
and never drives the reporting session's own state, so the situation it corrected cannot arise
the same way. Ported blindly it would have needed a `lastCronReportAt` column to feed it, for a
case nobody has hit yet.

## Surfaces

- **One card.** `components/chat/loop-bar.tsx` rendered `LoopCard` (from the JSON blob) and
  `ScheduleCard` (from the DB) side by side in the same strip. It is now
  `components/chat/schedule-bar.tsx` with only `ScheduleCard`.
- **One page.** `/cron`, unchanged apart from the done state.
- **One skill.** `apps/cli/template/.claude/skills/cron/SKILL.md`, covering both trigger
  vocabularies (定时任务 / routine and 循环 / 迭代直到…). `skills/loop/` is deleted.
- Composer chips stay at three, but the first now seeds a cron with a finish line
  (`ITERATE_TEMPLATE`) instead of a session loop.

## Deleted

Gateway: `readLoopState` + the `loopState` snapshot field, `deleteLoopFromState` and the
`loop-delete` AgentRequest, `LOOP_ITERATION_RE` / `loopTriggerSummary` and the
`[gateway] ↻ loop 触发` system row on both the tmux and SDK paths.

Dashboard: `server/loop-state.ts`, `lib/loop-marker.ts`, `chat.loopRuns`, `chat.deleteLoop`,
the `loopState` select and snapshot ingest, `lastLoopRoundAt` stamping, `loopRoundEvent` and
the `'loop'` push kind, `hasUnreadLoopRound`, `hasRunningLoop` and the `'loop'` cleanup blocker,
`unreadLoopRound` in `sessionStatusView`, `LoopCard` / `LoopRuns` / `LoopRunRow` /
`parseLoopRun`. `components/chat/loop-bar.tsx` → `schedule-bar.tsx`, 567 lines → 302.

Verified: gateway 644 tests + `tsc`; dashboard 722 tests + `tsc` + `next build`.

## Left standing on purpose

`ChatSession.loopState` and `ChatSession.lastLoopRoundAt` **stay in the schema**. Nothing reads
or writes them any more, and they will go in a follow-up migration — not this one, because
`vps-deploy.sh` runs `prisma migrate deploy` **before** `next build`, so dropping a column here
would leave the still-running old dashboard 500ing on every `getSession` poll for the length of
a build. Expand now, contract later.

Agents' own `.loop-state.json` files are also left alone by the rollout: nothing reads them, and
deleting one under a session that is mid-loop would strand it with no record of itself.

## Rollout

`scripts/rollout-cron-merge.sh` — installs the merged `cron` skill and the new `perfect-goal`
skill into every agent under `/Users/mac/claudeclaw`, removes `.claude/skills/loop/`, and
repairs the one stale sentence in each agent's `AGENTS.md`. Idempotent; `--dry` first.

**Order matters:** deploy the gateway and dashboard *before* running the rollout. An agent that
has the new skill but an old gateway will faithfully print `CRON_DONE`, and nothing will be
listening — the task would run forever with a stray line in every report.
