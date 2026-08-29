---
name: cron
description: The ONE skill for any repeating task — a fixed-interval routine and an iterate-until-done loop are the same object here. Use when the user says "定时任务", "每天/每周/每隔 N 分钟 做 X", "cron", "schedule", "routine", "提醒我定时", "循环", "持续迭代", "反复优化", "loop on X", "keep doing X until <cond>", "迭代直到达成 <目标>", "自调步", or "开启循环任务". Every one of them becomes a hermit cron - durable across restarts, listed on the dashboard /cron page, and every run reports back into the chat that created it.
user_invocable: true
---

# Cron — every repeating task, one mechanism

Whatever the user calls it — 定时任务, 循环, routine, "keep going until it's done" — you
create **a hermit cron**, and it always does all three of these:

- **fires on its own schedule**, driven by the gateway, so it survives a session restart, a
  gateway restart and a reboot;
- **reports into THIS conversation** — each finished run posts its final message into the chat
  the cron was created from, so the user watches it round by round without leaving the chat;
- **is listed on the dashboard `/cron` page**, with every run's full output, so nothing is
  lost when the conversation scrolls away.

Each run is an **isolated turn**: a fresh claude in this agent's directory that does not see
this conversation's context and is torn down afterwards. That is a feature — a daily job can
never grow this chat without bound — but it is also the one thing you must design around: see
"Runs that build on each other" below.

## When this fires

Two families of ask, one mechanism:

| The user says | Shape |
|---|---|
| 每天 / 每周 / 每隔 N 分钟·小时 + 做某事 · 定时任务 · routine · 提醒我每天… | **Recurring check** — each run is independent, runs forever until stopped |
| 循环 · 持续迭代 · 反复优化 · keep doing X until Y · 直到 <条件> · 迭代到 <目标> | **Run toward a finish line** — each run builds on the last and the cron ends itself when the goal is met |

## Required inputs — ask once if any is missing

1. **Task** — what one run does. Concrete and verifiable.
2. **Interval** — 每 N 分钟 / 小时 / 天. Minimum 1 minute, maximum 7 days.
3. **Finish line** — for the second family this is mandatory: a condition *this agent can check
   by itself*. "看起来不错" is not one; "打开首页截图，桌面宽度下没有横向滚动条" is.
   Make it something the run OBSERVES, not something it asserts about its own code — a green
   suite the same agent wrote is not a finish line, it is a mirror.
   For the first family there is no finish line and the cron runs until the user stops it —
   confirm that is what they want.
4. **Jitter (optional, encouraged for periodic checks)** — a ± random offset on the fire time
   so repeated runs do not hit an external service on the same tick. ±10% of the interval is a
   good default.

## Creating one

```
mcp__hermit__cron_create({
  prompt: "<the task — self-contained, see 'Writing the prompt'>",
  intervalMinutes: <N>,          // 30 = every half hour, 1440 = daily
  jitterMinutes: <M>,            // optional ± window, default 0
  title: "<short label>"         // optional, shown in the /cron list and on the chat card
})
```

Then tell the user, in one or two lines: the interval, the jitter, the finish line (or that
there is none), and that each run's result lands in this chat with the full history on /cron.

## Writing the prompt

The prompt is the whole brief for a claude that has never seen this conversation. Write it so
a stranger could run it.

Every prompt must do these, in order:

```
Read silently first: run the startup command in ./CLAUDE.md (it is the single source of truth
for the boot chain — do not hardcode a file list here), plus ./memory/<today>.md if present.

Do this run: <THE TASK>

Then CHECK IT BUILDS before reporting, and confirm the build actually passed. On failure:
roll back, or record the failure honestly. NEVER report success you did not verify.

Do not write unit tests to prove the round worked, and never report a passing count as the
result — a suite you wrote yourself goes green on your own assumptions, including the wrong
ones. When the task is finished (not every run), exercise it the way a person would once:
open the page, run the command for real, look at the output.

Then append a one-line result to ./memory/<today>.md.

Finally reply with ONE short report. It is posted into the chat, so LEAD WITH THE OUTCOME —
what is true now, then the self-test result. Not what you were about to do.
```

Two more rules that come from what actually breaks:

- **Lead with the outcome.** A run's output is kept from the *front* and capped at 32,768
  characters, so a report that opens with preamble gets its conclusion cut off.
- **Do not end the turn while a command is still running.** The pane is destroyed the moment
  you reply; a backgrounded build's result would never be reported.

## Runs that build on each other

An isolated run remembers nothing. So a cron that iterates toward a goal keeps its memory **in
a file**, not in context. Pick a path when you create it and name it in the prompt:

```
<work dir>/PROGRESS.md   — what is done, what is left, what the last run tried and what happened
```

The prompt then reads: `先读 <path>/PROGRESS.md，接着上一轮继续；这一轮结束前把进展写回去。`

## Heartbeat crons

A heartbeat is just a recurring cron whose task is "check whether anything needs the user's
attention". Every run's reply posts into the chat — there is no silent mode — so write the
prompt to keep a quiet round to a single short line:

- **Speak up** when something real happened: an important event, a deadline close by, a find
  worth sharing.
- **Nothing new** → one short line (e.g. 「一切正常，无事上报」). Never pad a quiet round into
  a fake update.
- A quiet round may still do upkeep silently: organize `evolution/`, run `git status`, distill
  recent reflections into `lessons.md` (see AGENTS.md, "Where each kind of event goes").

## Ending it — three ways

**1. The user stops it.** 停掉 / 删除 that task → `mcp__hermit__cron_delete({ id })`. To pause
without losing the history, `cron_update({ id, enabled: false })`.

**2. The cron ends itself.** This is what makes an iterate-until-done task possible. When a run
confirms the finish line is reached, it ends its reply with a line containing only:

```
CRON_DONE
```

The gateway strips that line, marks the cron **done** (it stops firing, stays on /cron with its
full history), and the chat card shows 已完成 instead of 已暂停. Put this instruction verbatim
into the prompt, next to the finish line:

```
达成条件：<the finish line>。每轮结束前对照检查一次；已经达成就在回复的最后单独一行输出
CRON_DONE，未达成就不要输出它。
```

`CRON_DONE` means "stop firing", and the report says which kind of stop it was. Reaching the
goal is the normal one. Giving up is the other legitimate one: a task that has failed the same
way three runs running is not going to succeed on the fourth, so end it and say plainly in the
report what blocked it and what decision you need. What is never allowed is writing `CRON_DONE`
after a check you did not actually run — that is the same lie as reporting an untested success,
except it also ends the work.

**3. The cron re-paces itself.** When the right gap between runs depends on what the last run
found ("自调步 / 你来定节奏"), the run ends its reply with a line containing only:

```
CRON_NEXT <minutes>
```

The gateway strips it and sets the interval to that many minutes from now. Same rules: 1 to
10080 minutes, and only emit it when you have a reason. Instruction for the prompt:

```
下一轮的间隔由你决定：回复最后单独一行输出 CRON_NEXT <分钟数>（还没到需要调整就不要输出）。
```

Both markers must be on their own line at the very end of the reply, with nothing else on that
line. They are read from the full output before it is truncated, so a long report cannot lose
them.

## Editing one

**Editing is `cron_update`, never delete + create.** Rewriting the prompt through `cron_update`
leaves the fire time alone, so a report that fires at 09:00 keeps firing at 09:00. Delete +
create resets the next fire to *now*, which quietly re-times the job to whenever you happened
to rewrite it — invisible until the user notices their morning report arriving in the
afternoon. Only `intervalMinutes` reschedules, and it recomputes from the last run.

```
mcp__hermit__cron_update({ id, prompt?, title?, intervalMinutes?, jitterMinutes?, enabled? })
```

Improved the task? `cron_update` the prompt. This is the normal way a cron's instructions
evolve — you are expected to edit your own schedules as you learn what the run should say.

## Listing

`mcp__hermit__cron_list()` → this agent's crons (id, title, interval, last status). Use it to
report, or to find an id before editing or deleting.

The user can do all of it on the **`/cron` page** too: enable/disable, edit the interval and
prompt, run now, delete, and read every run's full output.

## Guardrails

- **Every run must build.** That is the gate — not a test suite, and never one you wrote to
  prove yourself right. On failure, roll back and say so. Three consecutive failures the same
  way: stop the cron (`CRON_DONE`) and put the decision the user has to make at the top of
  that last report.
- **Test once, at the end.** An iterating cron checks its finish line by USING the thing, on
  the run that thinks it is done — not by re-running a suite every round.
- **An iterating cron needs a finish line.** Without one it edits the same project forever.
- **No hand-rolled schedulers.** No LaunchAgent, no `.plist`, no system crontab, no
  systemd-user timer. Those are invisible to the dashboard and bypass quota routing.
- **The harness's own `CronCreate` / `ScheduleWakeup` tools are not the mechanism here.** They
  die with the session and never reach /cron. If you catch yourself reaching for them, use
  `mcp__hermit__cron_create` instead.
- Interval is 1 minute to 7 days; a run is killed at 2 hours.
