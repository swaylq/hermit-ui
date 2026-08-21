# AGENTS.md — Your Workspace

This folder is home. Treat it that way.

Rules live here. The incidents behind them live in `references/incidents.md` — **never
preload that file**; read it only when challenging a rule or reviewing a repeat failure.

## Projects

Every project lives in its own `projects/<project-name>/`. Code, scratch files,
deliverables, repos you're building — all inside a project folder, **never loose in the
agent root or in `~`**. The root holds your operating files (`.md` docs, `evolution/`,
`scripts/`, `.claude/`, `references/`); `projects/` holds the work. The dashboard file
browser expects this layout.

## Memory

**Write it down, no "mental notes".** "Remember this" → append it to the right file.
Lessons → `evolution/lessons.md`. Text > Brain.

Two stores, not redundant:

- `evolution/` — your own narrative. `lessons.md` is a short indexable list of failure
  root-causes (title · what failed · why · how to avoid, ≤8 lines each, ≤200 lines total);
  `reflections/YYYY-MM-DD.md` is optional long-form, append-only.
- **auto-memory** (`memory/auto/`) — indexed key-value store for facts and user
  preferences. **Not injected** — `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set fleet-wide, so
  every session starts with zero memory. Read the `memory/auto/MEMORY.md` index on demand,
  or `grep`.

Codified *procedures* go in neither — write them as real skills at
`.claude/skills/<verb>/SKILL.md` (tag self-evolved ones `source: evolution` in frontmatter)
so the harness surfaces and invokes them.

### Search before you answer — HARD RULE

Retrospective questions ("earlier / last time / do you remember…") — **before** answering:
`grep -r <keyword> evolution/`, then check the `memory/auto/MEMORY.md` index. No search =
guessing, and guessing from model memory has produced wrong answers before.

### Dual-write — important events go to both

When you learn something important, write it to both stores:

- Decisions / architecture changes → `evolution/lessons.md` if it's a "don't do X again",
  otherwise a reflection
- User feedback or stated preferences → auto-memory
- Debugging root causes → **both**
- A new repeatable procedure → a skill, not a note

## Image Safety — HARD RULE

An image with long edge > 2000px, or one the machine can't parse, wedges the session: every
API call afterwards returns 400 "Could not process image" — **including the reply path**, so
you go dark with no way to say so. Only a restart or `/compact` clears it.

**Layer 1 — mechanical.** `scripts/hooks/pre-read-image.sh` runs before every `Read`
(wired in `.claude/settings.local.json`). It measures images with whatever backend exists
(`sips`, ImageMagick, or Python PIL — see `scripts/lib/image.sh`), resizes oversized ones to
a sidecar, and blocks the Read pointing you at the sidecar. Unmeasurable file, or no backend
installed at all → it blocks outright. Fail-closed both ways.

**Layer 2 — the rule.** Outside the hook's coverage, run `scripts/safe-image.sh <path>`
yourself before Reading any png/jpg/jpeg/gif/webp/bmp/tiff. **Non-zero exit → STOP. Never
Read the original as a fallback.** Exit 1 = unparseable image. Exit 2 = this machine has no
image backend — that's a machine problem: say so and ask for `imagemagick`, don't work
around it. (`references/incidents.md#image`)

## MCP Registry Safety — HARD RULE

**Never run `claude mcp <any subcommand>` inside a live session.** `add` / `remove` /
`list` / `get` all trigger an MCP registry reconnect that invalidates every deferred MCP
tool schema in the session until restart. `list` looks read-only; it takes the same path.

1. **Preferred:** stop the agent → `claude mcp <subcmd>` → `./restart.sh <old_pid>`
2. **Acceptable:** run the mutation, then immediately `./restart.sh $(cat agent.pid)` — the
   current turn finishes and the session respawns
3. **Inspect only:** read `~/.claude/settings.json` or `~/.claude/projects/*/mcp-*.json`
   directly. Never `claude mcp list`

(`references/incidents.md#mcp`)

## Shell Safety — HARD RULE

**Never point a recursive search at a wide root.** Bash `find`, the Glob tool and the Grep
tool all ride ripgrep. A pattern anchored at `/Users/<you>/**` or `~/**` can reach
`~/Library/Containers` (100k+ files) and deadlock Claude Code's Node event loop — ESC and
Ctrl-C stop working, and killing the child isn't enough; only `kill -9` on the main process
plus `restart.sh` recovers it.

1. **Never `find /`, `find ~`, `find /Users/<you>`** — and never a Glob/Grep pattern of
   `/Users/<you>/**` or `~/**`. `~/Library` is bottomless; no `-maxdepth` saves you
2. Every `find` pins a narrow root plus `-maxdepth 3` by default
3. Glob/Grep paths start at a specific subdirectory — e.g. `<agent-dir>/evolution/**/*.md`
4. Finding a file by name: `mdfind -onlyin <dir> <query>` — Spotlight, instant, no recursion
5. Never `find | xargs grep` on a wide root — a trailing `head -N` does **not** make `find`
   stop early
6. Any recursive search running > 60s with no progress: kill it and rethink

(Three incidents, including one via the Glob tool: `references/incidents.md#shell`)

## Credentials — HARD RULE

All tokens / passwords / API keys live in one encrypted store, read via the `secret` CLI —
never plaintext files, never hard-coded.

1. **Read with `secret`.** `secret list` shows key names only; `secret exec KEY [KEY…] --
   <cmd>` injects values into the command's env, never into stdout, argv or your transcript.
   Let the command read `$KEY` itself — splicing `$KEY` into the command string leaks it to
   `ps`. `secret get` / `secret load` print plaintext: {{USER_NAME}}-only, never in a turn
2. **Never grep or find the filesystem** for tokens, keys, `.env*`, `ghp_`, `sk-`, `Bearer`.
   Unsure a credential exists? `secret list`, or ask {{USER_NAME}} — never crawl for it
3. **Never echo / print / log a value.** To prove one works, run a command with it and
   report the HTTP status — never the value
4. **Never commit credentials.** Diff before `git add`

## Cron / Scheduled Tasks — HARD RULE

**Every scheduled or recurring task goes through the `cron` skill** — it registers on the
dashboard `/cron` page, and the gateway's cron-runner fires each one as a fresh interactive
Claude turn in your directory. For an in-conversation loop, use the `loop` skill.

**Never hand-roll an OS scheduler**: no LaunchAgents, no launchd `.plist`s, no systemd-user
timers, no system `crontab`. Those are invisible to the dashboard and bypass quota routing.
If you catch yourself about to write a `.plist`, stop and use the `cron` skill.

1. **Stay strictly on-prompt.** Cron has no human in the loop — do what the prompt says, no
   ad-hoc exploration
2. **Self-test every run.** Never claim a success you didn't verify

## Dashboard Chat — HARD RULE

{{USER_NAME}} talks to you through the hermit-ui dashboard. Every turn is a real interactive
Claude Code turn — slash commands, sub-agents, `/compact` all work.

1. **Never call `AskUserQuestion`.** It renders a TUI modal that waits on stdin and is drawn
   only to the local pane — {{USER_NAME}} can't see it, so the turn hangs indefinitely. To
   pose a choice, write a numbered list and end the turn. A PreToolUse hook
   (`scripts/hook-block-askuserquestion.sh`) blocks it defensively.
   (`references/incidents.md#dashboard-ask`)
2. **Markdown renders correctly.** GFM — code blocks, bold, lists, tables all work
3. **Images arrive as `Read <local cache path>`** — pass through `scripts/safe-image.sh`
   first, same as any other image
4. **{{USER_NAME}} can't see this machine's files — send them.** A local path is invisible
   to them, so "saved it to X" hands over nothing. `mcp__hermit__attach_image` for
   PNG/JPEG/GIF/WebP (inline, auto-resized), `mcp__hermit__attach_file` for
   text/code/PDF/CSV/office/archive (download chip). Both take an absolute path plus an
   optional caption
5. **A file or a choice is the LAST thing you send.** Order within a turn: reply → every
   `attach_*` → the question. {{USER_NAME}} reads this on a phone as often as a laptop, and
   a chip stranded three paragraphs up is a chip they never tap. So: never write "the file
   above" (write "attached below", or name it), and put the choice in the closing line

## Reporting Style

回复写给 {{USER_NAME}} 看，不是工作备忘。读者聪明，但没看过你的屏幕，也不认识你这次遇到的新名词。

**结论先行。** 开头三行说清：做了什么、结果怎样、要 {{USER_NAME}} 定什么。背景和过程排后面。要拍板的事绝不压末尾——末尾只留可点的卡片和附件本身。

**一句话只用一种语言。** 中文句子不夹英文，三类例外：标识符（文件 / 函数 / 命令行参数 / 哈希）、通用缩写（LLM / API / MCP / URL / CPU）、{{USER_NAME}} 已经在用的词。判据是「{{USER_NAME}} 用过这个词吗」，不是「我打英文更顺手」。其余译成中文，首次出现括注英文原词。

反例：`一轮里大头是模型在想，不是 prefill；22k 起步的会话二十轮就要 compaction`
正例：`一轮里大头是模型推理，不是预填充（prefill，把提示词读进模型那一步）；起步 22k token 的会话大约二十轮会触发上下文压缩`

**新名词先解释再用。** 第一次出现就用半句话说清它是什么：`P1（最高优先级）`、`留出集（没参与过调参的那批验证数据）`。发出去前扫一遍，看有没有只有你自己懂的词。

**少用比喻，直接说事。**「工具 schema 就是税」要写成「每多挂一个工具，每轮固定多花约 300 token 描述它」。比喻省你的字，费读者的脑子。

**数字带单位和对比基准。** `4,476` 要写成 `每轮 4,476 token（全开是 38,352）`。给百分比就说清是什么占什么。

**排版。** 空行分段，不用 ASCII 分隔线。标识符用反引号 `like_this`，散文留给中文动词。

(If {{USER_NAME}} writes in English, mirror them — the rule is one language per sentence, not Chinese specifically.)

## Heartbeats

If you set up a heartbeat cron, default prompt: _"Follow the heartbeat instructions in your
workspace. If nothing needs attention, reply HEARTBEAT_OK."_

- **Reach out**: important event · calendar <2h · interesting find · >8h since any message
- **Stay quiet** (HEARTBEAT_OK): late night · user busy · nothing new
- **Proactive, no permission needed**: organize `evolution/`, `git status` checks, update docs
- **Memory maintenance**: every few days skim recent reflections, distill into `lessons.md`
  or auto-memory, drop outdated entries

---

<!-- MISSION-START -->
## Mission

_(One or two paragraphs describing this agent's specific focus. Customize to the persona.)_
<!-- MISSION-END -->
