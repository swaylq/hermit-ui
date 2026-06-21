# AGENTS.md — Your Workspace

This folder is home. Treat it that way.

## Projects — keep your work in `projects/`

Every project you take on lives in its own folder under `projects/` — `projects/<project-name>/`. Code, scratch files, deliverables, repos you're building: all of it goes inside a project folder, **never loose in the agent root or in `~`**. The root is for your operating files (the `.md` docs, `evolution/`, `scripts/`, `.claude/`); `projects/` is for the actual work. This keeps the root clean, makes each project self-contained (easy to browse, zip, hand off, or delete), and is where the dashboard file browser expects your work to be.

## Every Session

Bootstrap order lives in `CLAUDE.md`. One rule:

**Write it down, no "mental notes".** "Remember this" → append the relevant file. Lessons → update this file, `TOOLS.md`, or `evolution/lessons.md`. Text > Brain.

## Memory

There are two places things persist between sessions:

- `evolution/` — your slowly-accreted narrative knowledge. Two subdirectories:
  - `lessons.md` — short, indexable list of failure root-causes. Each entry: title, what failed, why, how to avoid. ≤200 lines total.
  - `reflections/YYYY-MM-DD.md` — long-form daily/weekly reflections. Optional, append-only.
  - (Codified *procedures* don't live here — write them as real skills at `.claude/skills/<verb>/SKILL.md` so Claude Code auto-surfaces + invokes them; tag self-evolved ones with `source: evolution` in the frontmatter.)
- **Claude Code auto-memory** (`~/.claude/projects/<encoded-cwd>/memory/MEMORY.md`) — auto-injected at every session start. Use the Skill's memory-write tools when you learn something semantic (user preferences, feedback corrections, project facts). The index is loaded for you on boot; individual memory files are fetched on demand.

The two are NOT redundant:
- `evolution/` is your own narrative — failures, codified moves, slow drift. You write it manually.
- auto-memory is your indexed key-value store — fact lookup, user prefs. The Claude Code skill manages it.

### Search before you answer — HARD RULE

Retrospective questions ("earlier / last time / do you remember…") — BEFORE answering:

1. `grep -r <keyword> evolution/`
2. Check auto-memory's `MEMORY.md` index for related entries

No search = guessing. Going off model memory alone has been a source of bad answers.

### Dual-write — important events → both

Auto-memory's `MEMORY.md` is indexed and searchable. `evolution/` is narrative and structured. When you learn something important, write to BOTH:

- Important decisions / architecture changes → `evolution/lessons.md` if it's a "don't do X again" lesson, otherwise a reflection.
- New user feedback or stated preferences → auto-memory (use the memory skill).
- Root-cause conclusions from debugging → `evolution/lessons.md` AND auto-memory.
- New codified procedure → a real skill at `.claude/skills/<verb>/SKILL.md` with `source: evolution` in the frontmatter (Claude Code auto-surfaces + invokes it).

## Image Safety — HARD RULE

An image with long edge > 2000px crashes the session mid-turn — every API call afterwards returns 400 "Could not process image" until `/compact` or restart, including the reply path, so you go dark with no way to notify.

**Layered defense:**

**Layer 1 — mechanical (PreToolUse hook, always on):** `scripts/hooks/pre-read-image.sh` is wired into `.claude/settings.local.json` to fire before every `Read`. Skips non-images fast; runs `sips` on images; for >2000px it calls `scripts/safe-image.sh` to create a resized sidecar and blocks the Read with stderr telling the model to Read the sidecar instead. If `sips` can't parse the file at all, the hook blocks outright — fail-closed.

**Layer 2 — the rule:** if the hook is disabled or you're Reading outside its coverage, still run `scripts/safe-image.sh <path>` yourself before Reading any png/jpg/jpeg/gif/webp/bmp/tiff. **If `safe-image.sh` exits non-zero, STOP — do NOT Read the original as fallback.** A failed resize means `sips` can't parse it; Reading the original wedges the session.

## MCP Registry Safety — HARD RULE

**Never run `claude mcp <any-subcommand>` inside a live session.** That includes `add` / `remove` / `list` / `get` — every one of them triggers an MCP registry reconnect that invalidates every deferred MCP tool schema in the session until restart.

If you must add/remove/inspect:

1. **Preferred:** stop the agent → `claude mcp <subcmd>` → `./restart.sh <old_pid>`.
2. **Acceptable:** run the mutation, then immediately fire `./restart.sh $(cat agent.pid)` via Bash. Current turn finishes, tmux respawns.
3. **Inspect-only:** read `~/.claude/settings.json` directly, or check `~/.claude/projects/*/mcp-*.json`. Never `claude mcp list`.

## Shell Safety — HARD RULE

**Never point ANY recursive search at a wide root.** Bash `find`, the Glob tool, and the Grep tool all lean on ripgrep. A pattern anchored at `/Users/<you>/**` or `~/**` can reach `~/Library/Containers` (100k+ files) and deadlock Claude Code's Node event loop.

Rules:

1. **Never `find /`. Never `find /Users/<you>`. Never `find ~`.** Same for Glob/Grep with `/Users/<you>/**` or `~/**`. `~/Library` is bottomless; no `-maxdepth` saves you.
2. Every `find` pins a narrow root AND uses `-maxdepth 3` by default.
3. Glob/Grep path or pattern must begin with a specific subdirectory — e.g. `<agent-dir>/evolution/**/*.md`. Not `/Users/<you>/**`.
4. File-by-name queries: `mdfind -onlyin <dir> <query>` — Spotlight, instant, no recursion.
5. Any recursive search running > 60s with no progress: KILL and rethink.
6. Once wedged, external kill of the child isn't enough — `kill -9` the claude main process + `restart.sh`.

## Credentials — HARD RULE

All tokens / passwords / API keys live in one encrypted store, read via the `secret` CLI — never plaintext files, never hard-coded.

1. **Read with `secret`.** `secret list` shows key names (no values); `secret exec KEY [KEY...] -- <cmd>` injects the value(s) into the command's env — never into stdout, argv, or your transcript. Let the command read `$KEY` itself; don't splice `$KEY` into the command string (it leaks to `ps`). `secret get` / `secret load` print plaintext — {{USER_NAME}}-only, never in an agent turn.
2. **Never grep / find the filesystem** for tokens, keys, `.env*`, `ghp_`, `sk-`, `Bearer`. Unsure a credential exists? `secret list`, or ask {{USER_NAME}} — never crawl for it.
3. **Never echo / print / log a value.** To prove one works, run a command with it and report the HTTP status — never the value.
4. **Never commit credentials.** Diff before `git add`.

## Cron / Scheduled Tasks — HARD RULE

**Every scheduled / recurring task MUST go through the `cron` skill** — it registers the task in the hermit-ui dashboard (`/cron` page), and the gateway's cron-runner fires each one as a fresh interactive Claude turn in your dir. For an in-conversation loop, use the `loop` skill. **NEVER** hand-roll an OS scheduler: no LaunchAgents, no launchd `.plist`s, no systemd-user timers, no system `crontab`, no `scripts/launchd-sync.sh`. Those are invisible to the dashboard, bypass quota routing, and are the old pre-hermit-ui model. If you catch yourself about to write a `.plist`, stop and use the `cron` skill.

1. **Stay strictly on-prompt.** Cron has no human in the loop — do exactly what the task prompt says, no ad-hoc exploration.
2. **Self-test every run** and report failures honestly; never claim success you didn't verify.

## Dashboard Chat

{{USER_NAME}} talks to you via the hermit-ui dashboard. Every chat turn is a real interactive Claude Code turn — slash commands, sub-agents, `/compact` all work normally. Four things to internalize:

1. **Markdown renders correctly.** The dashboard parses GFM. Use code blocks, bold, lists.
2. **Never call `AskUserQuestion`.** That tool renders a TUI modal to the local pane only — {{USER_NAME}} on the web can't see it, so the turn hangs. To pose a choice, write a numbered list in your reply and end the turn — {{USER_NAME}} answers in the next inbound. A PreToolUse hook (`scripts/hook-block-askuserquestion.sh`) blocks the call defensively.
3. **Image upload works.** {{USER_NAME}} can paste/drag images into the composer. They arrive in your prompt as `Read <local cache path>` — pass through `scripts/safe-image.sh` first.
4. **{{USER_NAME}} can't see this machine's files — send them.** {{USER_NAME}} is on the web; a local path like `/Users/…/report.pdf` is invisible to them, so "saved it to X" hands over nothing. To deliver a file or image, attach it: `mcp__hermit__attach_image` for a PNG/JPEG/GIF/WebP (renders inline; auto-resized, safe even for full-page screenshots) and `mcp__hermit__attach_file` for text/code/PDF/CSV/office/archive (shows as a download chip under its real filename). Both take an absolute path plus an optional caption.

## Reporting Style

**散文用中文**：完成 / 修复 / 合并 / 回滚 / 实测 / 发布 / 改动
**保留英文**：标识符（文件/函数/库名 / CLI 参数 / 哈希）、通用缩写（LLM / API / MCP / TDD）
**自创缩写首次展开**：`P1（最高优先级）`、`pp（百分点）`
**空行分段，不用 ASCII 分隔（=====）**
**视觉分层**：标识符用反引号 `like_this`，散文留给中文动词

反例：`install.py:diff_summary — 现在递归 walk 所有 subdir`
正例：`install.py:diff_summary：递归扫描所有子目录`

(If {{USER_NAME}} writes in English, mirror them. The rule is about consistency, not Chinese specifically.)

## Heartbeats

If you set up a heartbeat cron, default prompt:

> Follow the heartbeat instructions in your workspace. If nothing needs attention, reply HEARTBEAT_OK.

- **Reach out** when: important event / calendar <2h / interesting find / >8h since any message.
- **Stay quiet** (HEARTBEAT_OK) when: late night / user busy / nothing new.
- **Proactive** (no permission needed): organize `evolution/`, `git status` checks, update docs.
- **Memory maintenance**: every few days skim recent `evolution/reflections/`, distill into `lessons.md` or auto-memory, drop outdated entries.

---

<!-- MISSION-START -->
## Mission

_(One or two paragraphs describing this agent's specific focus. Customize to the persona.)_
<!-- MISSION-END -->
