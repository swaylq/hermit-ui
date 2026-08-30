---
name: perfect-goal
description: Drive one goal to a finish a fresh reviewer signs off on. Write the goal down as a short checkable list, then work in rounds - each round only has to BUILD. When the list looks met, drive the thing end to end once, screenshot anything with a UI, and hand it to a fresh critic subagent that only reports real problems. Stop when a fresh critic finds no blocking problem, inside a 24-hour budget. Use when the user says "做到完美", "要求完美", "打磨到没问题", "严格验收", "反复改直到没问题", "perfect this", "make it flawless", "iterate until a reviewer has no complaints", or hands over a goal and expects it fully delivered rather than attempted.
user_invocable: true
---

# perfect-goal — finish a goal a critic can sign off on

Ordinary work stops when *you* think it is done. This skill moves the finish line to one
fresh pair of eyes — a critic subagent with none of your context, whose only job is to find
real problems. When it finds none, you are done. Not perfect for all eternity: done.

**Time budget: 24 hours wall-clock, hard.** A goal that cannot be finished in 24 hours is
too big — cut its scope, not its quality. From the first round you are aware of the clock:
scope the goal so it fits, and stop opening new rounds when you are near the limit.

Three phases: write the goal down, work in rounds, converge.

---

## Phase 1 — write the goal down before touching anything

Create `<work dir>/goal/GOAL.md`. Not a paraphrase of the request — a list someone else
could grade you against:

```markdown
# 目标
<一句话。做完之后世界上多了什么。>

# 验收标准
每条都要能被别人独立验证，不能是「感觉好」。
1. [ ] <可验证的事实> — 怎么验证：<命令 / 打开哪个 URL 做什么 / 看哪张截图>
2. [ ] ...

# 不做什么
<明确排除的范围，防止越做越大。>

# 怎么跑起来
<把它跑起来的确切命令 / URL / 端口。评审 agent 要照着这个自己跑一遍。>
```

Rules for the list:

- **Every line names its own check.** 「按钮好看」不是验收标准；「主按钮在桌面宽度下完整可见、
  点击后有反馈——看 `goal/shots/` 里对应截图」是。
- **Short is good.** 三到六条。每多一条，测试和评审的工作量都翻倍。宁可把范围裁小，别把清单写长。
- **Write the failure modes you already know about** — 空数据、超长文本、刷新页面之后。这些是
  评审第一轮最容易挑的，自己先写进去。

Then post the 验收标准 into the chat as a short list and start working. Do not wait for
approval — but if one criterion is genuinely ambiguous and getting it wrong would waste the
whole effort, ask that one question with `mcp__hermit__ask` and keep going on the rest.

---

## Phase 2 — rounds

Keep a log at `<work dir>/goal/ROUNDS.md`. One block per round: 这轮改了什么、build 过没过、评审提了
什么、哪些修了哪些没修（以及为什么）、**本轮开始时间**。The clock is part of the log — this is
how the 24-hour budget is tracked.

Steps 1 and 2 are every round. Steps 3 to 5 fire only when you believe the list is met —
that is the difference between converging and testing yourself in circles.

### 1. Do the highest-severity open work

One coherent theme per round. Fixing a blocking bug and restyling a footer in the same round
makes the critic's verdict unattributable.

### 2. Make sure it builds. That is the whole per-round bar.

Run the project's build (or, for something with no build step, start it and see it come up).
A round that does not build is not a round.

**Do not write unit tests to prove your change works, and never report a passing count as
evidence.** Tests you wrote yourself encode your own assumptions — the same assumptions that
produced the bug. They go green whether or not a person can use the thing.

If the project already has a suite, weigh what a run costs. Seconds — run it before you land,
as a regression check on code that isn't yours. Minutes (a browser suite, a full acceptance
pass) — only for a round that changed real behaviour, never for a round that moved a CSS rule
or a string, and never a second time just to show that a check you wrote goes red on the old
code. Either way it is not proof your feature works.

The proof is the next section, and it happens ONCE — when the list looks met, not every round.

### 3. When the criteria look met — drive it end to end, once

Not after every edit. Not every round. When you believe the 验收标准 are actually satisfied,
use the thing the way a person would: open the page, click through the flow, run the command
for real, throw real data at it. That single pass is what "tested" means here.

Scale it to what changed. A restyle or a copy edit is proven by looking at it; a suite adds
nothing a screenshot doesn't already show.

A screenshot is the minimum for any UI: at least one real shot from that pass, and the critic
must look at it. 「我测过了没问题」是这句话存在要防的东西。

What to shoot:

- **At least one shot of the main state** — the page or screen doing the thing the goal is about.
- **One shot per state the criteria name.** 验收标准点名的状态（空、出错、超长文本…）各拍一张；
  没点名的不用拍。
- **Two widths only if the criteria call for responsive.** 只有验收标准明确说「手机宽度下不坏」
  这类要求，才补一张 390×844；否则一张桌面宽度就够。
- **A game:** not the title screen — one shot of it actually being played. Anything beyond that
  is optional unless a criterion names it.

How to shoot:

```
mcp__playwright-browser__browser_navigate({ url })         # a local file:// URL works for a static page
mcp__playwright-browser__browser_resize({ width, height })
mcp__playwright-browser__browser_take_screenshot({ filename })
```

Drive the game or the interaction with `browser_press_key` / `browser_click` /
`browser_evaluate` between shots. For a page that needs a server, the `live-preview` skill puts
it on a URL; for a longer automation, the `browser-automation` skill.

Save everything to `<work dir>/goal/shots/round-<N>-<what>.png`, `<N>` being the round
that believed it was done.

**Before you or the critic `Read` any image, run `{{AGENT_DIR}}/scripts/safe-image.sh <path>` and
read the path it prints.** A non-zero exit means stop and report it — never read the original as a
fallback. A malformed or oversized image makes every later API call in that session fail,
including the one that would tell the user about it.

### 4. Hand it to a critic

Same trigger as step 3 — when the list looks met, not every round. A critic spun up after
every small edit is the dense testing this skill is trying to avoid; it burns rounds and
trains you to discount its findings.

Spawn a subagent with your harness's subagent tool — `Agent` on newer Claude Code, `Task` on
older; `subagent_type: "general-purpose"`. Fresh context is the whole point: do not summarise
your reasoning for it, hand it the artifacts and let it form its own view.

The brief:

```
你是这个成果的评审。你的任务是找出哪里还有真问题——不是鼓励，不是总结，不是打分，也不是鸡蛋里挑骨头。

目标和验收标准：<work dir>/goal/GOAL.md（先读它）
这一轮的改动：<改了哪些文件 / git diff 的范围>
怎么自己跑起来：<GOAL.md「怎么跑起来」那一段，照着做，不要只读代码>
证据截图：<每张截图的绝对路径，以及它拍的是什么状态>
  读任何图片之前先跑 {{AGENT_DIR}}/scripts/safe-image.sh <路径>，读它打印出来的那个路径；
  这个脚本非零退出就停下来报告，不要退回去读原图。

要求：
1. 逐条对着验收标准检查，说清楚每一条是「达成 / 未达成 / 无法验证」。
2. 自己动手验证关键几条：跑命令、开页面、点一下、输个超长字符串。
3. 截图要真的看，和验收标准不一致的地方指出来。
4. 只报值得修的真问题。风格偏好、可改可不改的小事，不要往上写。
5. 不要编造问题。挑不出来就说挑不出来——假问题和漏掉真问题一样糟。

按这个格式返回，不要有别的话：

BLOCKING:   （验收标准没达成，或者会崩 / 丢数据 / 明显用不了。必须修。）
  - <文件:行 或 哪个界面> — <问题> — <怎么复现>
MAJOR:      （明显影响质量，但不挡验收。能顺手修就修，否则记下来留给用户。）
  - ...
MINOR:      （记下来即可，不影响交付。）
  - ...
VERDICT: CLEAN            ← 没有 BLOCKING 就写这个（MAJOR/MINOR 可以有）
VERDICT: NEEDS_WORK       ← 还有 BLOCKING
```

A critic handed the same instruction twice converges on the same blind spot as you. If you
want a second opinion, give the next critic a different lens (round 1 只看验收标准，round 2
只看会崩的输入) — but a second critic is optional, not required.

### 5. Fix what it found

BLOCKING gets fixed this round or next. MAJOR gets fixed if it is cheap, otherwise it goes
into ROUNDS.md and the closing report. MINOR goes into ROUNDS.md and is either fixed at the
end or listed to the user as knowingly left.

Disagreeing with the critic is allowed, and it has to be written down: 在 ROUNDS.md 里写清楚
为什么这条不成立。An unrecorded dismissal is how a real problem gets buried.

---

## Phase 3 — converge

**Done means: one fresh critic returns `VERDICT: CLEAN`.** If you are not confident, run a
second critic with a different brief as a check — but that is optional, and it does not need
to be CLEAN twice to stop.

Guards, so this terminates:

- **24 hours wall-clock.** The hard limit. When you pass ~20 hours, stop opening new rounds:
  finish the round in flight, write the closing report, and list what is left. A goal that
  cannot converge in 24 hours was scoped wrong, not one round short of perfect.
- **Five rounds maximum.** Hit it and stop: report to the user what is still open and what you
  would do next.
- **Three rounds with no reduction in BLOCKING count** — stop and say so. You are going in
  circles; the user has to decide something.
- **A criterion that turns out to be impossible** — stop and say so, rather than quietly
  rewriting the goal to something you can hit. Editing `GOAL.md` mid-flight is allowed only to
  make a criterion *more* specific, never weaker, and the edit goes in ROUNDS.md.

When it converges, the closing report is short: 目标达成、每条验收标准的结论、明知留下的 MAJOR/MINOR、
以及**最后一轮的截图**——用 `mcp__hermit__attach_image` 发进对话，图放在整条回复的最后。
The user cannot see this machine's files; a path is not a deliverable.

---

## Work that does not fit in one turn

If the rounds will not finish before the context runs out, do not race them. Hand the loop to a
scheduled task with the **`cron` skill**: one cron, interval to taste, whose prompt is

```
读 <work dir>/goal/GOAL.md 和 <work dir>/goal/ROUNDS.md，按 perfect-goal skill 继续下一轮。
达成条件：一个全新评审返回 VERDICT: CLEAN。达成就在回复最后单独一行输出 CRON_DONE。
如果已接近 24 小时预算，直接收尾汇报，也输出 CRON_DONE。
```

That cron reports each round into this conversation and ends itself on convergence, which is
exactly the shape of this skill. `GOAL.md` and `ROUNDS.md` are what carry the work across runs
— which is why phase 1 and the round log are not paperwork.

---

## Guardrails

- **The critic is a subagent, never yourself.** Reviewing your own round in the same context
  reproduces every assumption that caused the defect.
- **Never write `VERDICT: CLEAN` on the critic's behalf**, never summarise its findings away,
  and never skip a round because the change was small.
- **At least one screenshot for anything with a UI.** One real screenshot, looked at by the
  critic. That is the floor; it is not a production stills shoot.
- **Report failures honestly.** A round where the build broke is a round that says the build
  broke. This skill is worthless the moment its log starts flattering the work.
- **Build every round; test once.** The per-round gate is the build. The end-to-end pass and
  the critic come when the criteria look met — testing densely does not find more, it just
  makes each result cheaper to ignore.
- **The clock is part of the plan, not an afterthought.** Scope the goal for 24 hours at the
  start; do not discover the limit at hour 23.
- One goal at a time. Two goals in flight means neither has a critic that understands it.
