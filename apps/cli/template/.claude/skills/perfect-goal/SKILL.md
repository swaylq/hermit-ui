---
name: perfect-goal
description: Drive one goal to a finish that a hostile reviewer signs off on. Write the goal down as a checkable list, then work in rounds - each round builds, self-tests, captures evidence (real screenshots for anything with a UI), and hands everything to a fresh critic subagent whose only job is to find what is wrong. Fix what it finds, run it again, and stop only when two different critics in a row find nothing. Use when the user says "做到完美", "要求完美", "打磨到没问题", "严格验收", "反复改直到没问题", "perfect this", "make it flawless", "iterate until a reviewer has no complaints", or hands over a goal and expects it fully delivered rather than attempted.
user_invocable: true
---

# perfect-goal — finish a goal a critic cannot fault

Ordinary work stops when *you* think it is done. That is the failure this skill exists to
prevent: you are the worst possible judge of your own output, because everything you got wrong
you got wrong for a reason that still looks right to you.

So the finish line is moved outside yourself. **A fresh critic — a subagent with none of your
context and an explicit mandate to find fault — has to run out of complaints.** Twice, with two
different critics. Until then you are not done, no matter how done it feels.

Three phases: write the goal down, work in rounds, converge.

---

## Phase 1 — write the goal down before touching anything

Create `<work dir>/goal/GOAL.md`. Not a paraphrase of the request — a list someone else could
grade you against:

```markdown
# 目标
<一句话。做完之后世界上多了什么。>

# 验收标准
每条都要能被别人独立验证，不能是「感觉好」。
1. [ ] <可验证的事实> — 怎么验证：<命令 / 打开哪个 URL 做什么 / 看哪张截图的哪里>
2. [ ] ...

# 不做什么
<明确排除的范围，防止越做越大。>

# 怎么跑起来
<把它跑起来的确切命令 / URL / 端口。评审 agent 要照着这个自己跑一遍。>
```

Rules for the list:

- **Every line names its own check.** 「按钮好看」不是验收标准；「1440px 和 390px 两个宽度下，
  主按钮都完整可见、不换行、点击后 300ms 内有视觉反馈——看 `goal/shots/` 里对应截图」是。
- **Failure modes are criteria too.** 空数据、超长文本、断网、连点两次、刷新页面之后。这些是
  评审第一轮必挑的地方，自己先写进去。
- **Between three and twelve lines.** 少于三条说明目标没想清楚；多于十二条说明该拆成两个目标。

Then post the 验收标准 into the chat as a short list and start working. Do not wait for
approval — but if one criterion is genuinely ambiguous and getting it wrong would waste the
whole effort, ask that one question with `mcp__hermit__ask` and keep going on the rest.

---

## Phase 2 — rounds

Keep a log at `<work dir>/goal/ROUNDS.md`. One block per round: 这轮改了什么、自测结果、评审提了
什么、哪些修了哪些没修（以及为什么）。This file is what lets the work survive a restart, a
context compaction, or a handover to a scheduled run.

Each round, in order:

### 1. Do the highest-severity open work

One coherent theme per round. Fixing a blocking bug and restyling a footer in the same round
makes the critic's verdict unattributable.

### 2. Self-test before showing anyone

Run the build, the tests, the type check, the actual program. A round that hands the critic
something that does not even run wastes the critic and teaches you nothing.

### 3. Capture evidence — screenshots are not optional

**HARD RULE: anything with a user interface — a web page, an app screen, a game — is not
accepted without screenshots, and the critic must have looked at them.** "我测过了没问题" is
exactly the claim this skill exists to distrust.

What to shoot, for a page or an app:

- **Two widths at minimum**: 1440×900 desktop and 390×844 phone.
- **Every state the criteria mention**: empty, loading, filled, error, and the long-text case.
- Anything you changed this round, before and after.

What to shoot, for a **game**:

- Not the title screen. **Screenshots of it actually being played**: 开局第一帧、进行到中途、
  得分/状态变化之后、失败或通关的那一刻、以及一个边界情况（比如同时按两个键、连点、暂停后恢复）。
- If it animates, take a short burst of shots across the animation rather than one frame.
- A game that cannot be driven far enough to screenshot mid-play is not testable, and "跑起来了"
  is not evidence. Automate the input (keyboard events through the browser) until you can shoot
  the states above.

How to shoot:

```
mcp__playwright-browser__browser_navigate({ url })         # a local file:// URL works for a static page
mcp__playwright-browser__browser_resize({ width, height })
mcp__playwright-browser__browser_take_screenshot({ filename })
```

Drive the game or the interaction with `browser_press_key` / `browser_click` /
`browser_evaluate` between shots. For a page that needs a server, the `live-preview` skill puts
it on a URL; for a longer automation, the `browser-automation` skill.

Save everything to `<work dir>/goal/shots/round-<N>-<what>.png`.

**Before you or the critic `Read` any image, run `{{AGENT_DIR}}/scripts/safe-image.sh <path>` and
read the path it prints.** A non-zero exit means stop and report it — never read the original as a
fallback. A malformed or oversized image makes every later API call in that session fail,
including the one that would tell the user about it.

### 4. Hand it to a critic

Spawn a subagent with your harness's subagent tool — `Agent` on newer Claude Code, `Task` on
older; `subagent_type: "general-purpose"`. Fresh context is the whole point: do not summarise
your reasoning for it, hand it the artifacts and let it form its own view.

The brief:

```
你是这个成果的评审。你的任务是找出它哪里不行——不是鼓励，不是总结，不是打分。

目标和验收标准：<work dir>/goal/GOAL.md（先读它）
这一轮的改动：<改了哪些文件 / git diff 的范围>
怎么自己跑起来：<GOAL.md「怎么跑起来」那一段，照着做，不要只读代码>
证据截图：<每张截图的绝对路径，以及它拍的是什么状态>
  读任何图片之前先跑 {{AGENT_DIR}}/scripts/safe-image.sh <路径>，读它打印出来的那个路径；
  这个脚本非零退出就停下来报告，不要退回去读原图。

要求：
1. 逐条对着验收标准检查，说清楚每一条是「达成 / 未达成 / 无法验证」，未达成和无法验证都要说
   具体是什么挡住了。
2. 自己动手验证，别只看代码：跑命令、开页面、点一下、输个超长字符串、把数据清空再看一遍。
3. 截图要真的看。截图里和验收标准不一致的地方，直接指出来在哪一块。
4. 主动找验收标准没覆盖到的问题：会崩的输入、race、没处理的错误、明显的可用性问题、
   在手机宽度下坏掉的布局。
5. 不要编造问题。挑不出来就说挑不出来——假问题和漏掉真问题一样糟。

按这个格式返回，不要有别的话：

BLOCKING:   （不修就不算达成目标的）
  - <文件:行 或 哪个界面> — <问题> — <怎么复现>
MAJOR:      （明显影响质量，应该这一轮修）
  - ...
MINOR:      （可以记下来，不修也能交付）
  - ...
VERDICT: CLEAN            ← 只有 BLOCKING 和 MAJOR 都为空时才写这个
VERDICT: NEEDS_WORK       ← 其他情况
```

Rotate the lens between rounds so two critics never look the same way. Round 1 反着读验收标准，
round 2 只找会崩的输入和错误处理，round 3 只看手机宽度和可用性，round 4 只看截图和真实操作
手感。A critic that keeps being handed the same instruction converges on the same blind spot as
you.

### 5. Fix what it found

BLOCKING and MAJOR get fixed this round or next. MINOR goes into ROUNDS.md and gets a decision
at the end — fixed, or listed to the user as knowingly left.

Disagreeing with the critic is allowed, and it has to be written down: 在 ROUNDS.md 里写清楚
为什么这条不成立。An unrecorded dismissal is how a real problem gets buried.

---

## Phase 3 — converge

**Done means: two consecutive rounds, with two differently-briefed critics, both returning
`VERDICT: CLEAN`.** One clean verdict is not enough — a critic that finds nothing on its first
look is more often a tired critic than a finished product.

Guards, so this terminates:

- **Ten rounds maximum.** Hit it and stop: report to the user what is still open and what you
  would do next. Ten rounds of no convergence is a goal that was written wrong, not a project
  that needs an eleventh.
- **Three rounds with no reduction in BLOCKING count** — stop and say so. You are going in
  circles; the user has to decide something.
- **A criterion that turns out to be impossible** — stop and say so, rather than quietly
  rewriting the goal to something you can hit. Editing `GOAL.md` mid-flight is allowed only to
  make a criterion *more* specific, never weaker, and the edit goes in ROUNDS.md.

When it converges, the closing report is short: 目标达成、每条验收标准的结论、明知留下的 MINOR、
以及**最后一轮的截图**——用 `mcp__hermit__attach_image` 发进对话，图放在整条回复的最后。
The user cannot see this machine's files; a path is not a deliverable.

---

## Work that does not fit in one turn

If the rounds will not finish before the context runs out, do not race them. Hand the loop to a
scheduled task with the **`cron` skill**: one cron, interval to taste, whose prompt is

```
读 <work dir>/goal/GOAL.md 和 <work dir>/goal/ROUNDS.md，按 perfect-goal skill 继续下一轮。
达成条件：连续两轮不同视角的评审都返回 VERDICT: CLEAN。达成就在回复最后单独一行输出 CRON_DONE。
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
- **No screenshot, no acceptance** for anything with a UI. Not negotiable, not for "just a CSS
  tweak".
- **Report failures honestly.** A round where the build broke is a round that says the build
  broke. This skill is worthless the moment its log starts flattering the work.
- One goal at a time. Two goals in flight means neither has a critic that understands it.
