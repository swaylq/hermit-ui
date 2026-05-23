# AGENTS.md — Your Workspace

This folder is home. Treat it that way.

## Every Session

Bootstrap order lives in `CLAUDE.md`. One rule:

**Write it down, no "mental notes".** "Remember this" → append the relevant file. Lessons → update this file, `TOOLS.md`, or `evolution/lessons.md`. Text > Brain.

## Memory

There are two places things persist between sessions:

- `evolution/` — your slowly-accreted knowledge. Three subdirectories:
  - `lessons.md` — short, indexable list of failure root-causes. Each entry: title, what failed, why, how to avoid. ≤200 lines total.
  - `skills/<verb>.md` — codified procedures you figured out. SKILL.md-style: heading + steps + caveats. ≤15KB each.
  - `reflections/YYYY-MM-DD.md` — long-form daily/weekly reflections. Optional, append-only.
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
- New codified procedure → `evolution/skills/<verb>.md`.

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

## Token Safety — HARD RULE

Credentials live at well-known paths documented in `TOOLS.md`. Reference by path; never crawl the filesystem for them.

1. **Never grep or find the filesystem for tokens, API keys, secrets, `.env*`, `api_key`, `ghp_`, `sk-`, `Bearer`.** If you don't know where a credential lives, check `TOOLS.md` or ask {{USER_NAME}}.
2. **Never echo / print / log a token value.** Report HTTP status / response metadata, never the token itself.
3. **Never pass a token on the command line.** `curl -H "Authorization: Bearer $TOKEN"` exposes it in `ps auxwww`. Use `--header @file`, stdin, or an env var the callee already has.
4. **Never commit credentials.** `.gitignore` ships with `.env*` and secrets paths. Diff before `git add`.
5. **Historical leaks** get redacted in place: `[REDACTED YYYY-MM-DD — <why>]`. Don't wait for rotation.

## Cron Safety — HARD RULE

Cron tasks run via LaunchAgents (macOS) or systemd-user timers (Linux).

1. **Stay strictly on-prompt.** If `cron/<task>.md` says do X, do X — no ad-hoc exploration. Cron has no human in the loop.
2. **Hard runtime ceiling.** Wrap every cron in `scripts/with-timeout.sh 1200` (20 min ceiling).
3. **Default to `scripts/claude-tmux-run.sh`, not `claude -p`.** Starting 2026-06-15 Anthropic splits Claude Max quota into Interactive (`claude` in a TTY) vs Agent SDK (`-p` / SDK) buckets — SDK is the smaller one priced at full API rates. `claude-tmux-run.sh` runs claude interactively inside an ephemeral tmux pane and bills the Interactive bucket.
4. **Legacy `-p` flags (if you must):** pass `--no-session-persistence` (the post-task JSONL flush has hung past 1200s). Never `--bare` on Claude Max OAuth (it demands `ANTHROPIC_API_KEY`).

## Dashboard Chat

{{USER_NAME}} talks to you via the hermit-ui dashboard. Every chat turn is a real interactive Claude Code turn — slash commands, sub-agents, `/compact` all work normally. Three things to internalize:

1. **Markdown renders correctly.** The dashboard parses GFM. Use code blocks, bold, lists.
2. **Never call `AskUserQuestion`.** That tool renders a TUI modal to the local pane only — {{USER_NAME}} on the web can't see it, so the turn hangs. To pose a choice, write a numbered list in your reply and end the turn — {{USER_NAME}} answers in the next inbound. A PreToolUse hook (`scripts/hook-block-askuserquestion.sh`) blocks the call defensively.
3. **Image upload works.** {{USER_NAME}} can paste/drag images into the composer. They arrive in your prompt as `Read <local cache path>` — pass through `scripts/safe-image.sh` first.

## CLI Commands via Natural Language

{{USER_NAME}} triggers Claude Code built-in slash commands — and full session restart — through plain language. Recognize the intent, then route through `scripts/exec-cli-command.sh "/<command>" <delay-seconds>` for CLI commands (schedules `tmux send-keys` with default 5s delay so the current turn finishes cleanly), or `./restart.sh $(cat agent.pid) &` via Bash for full restart.

Safe → invoke directly, then reply confirming:

- "compact" / "压缩上下文" → `/compact`
- "switch to opus/sonnet/haiku" → `/model opus` (always pass the model as arg; bare `/model` opens a picker and is blocked)
- "status" / "查状态" → `/status`

Destructive → confirm once unless {{USER_NAME}} said "force" / "yes" / "立即":

- "clear context" / "reset" / "清空" → `/clear`
- "exit" / "logout" / "退出" → `/exit` or `/logout`
- "restart" / "重启" → run `./restart.sh $(cat agent.pid) &` via Bash. `restart.sh` sleeps 3s, kills the old PID, tmux respawns. Loses current turn state but recovers from wedges.

Interactive commands are BLOCKED by `exec-cli-command.sh` (exit 4) — they open modal panels that freeze the REPL. If asked, explain it's interactive-only:

- `/help /config /memory /agents /mcp /permissions /bashes /hooks /ide`
- `/login /resume /bug /output-style /statusline /terminal-setup /vim`
- `/model` with NO arg

Reply pattern after invoking: "Scheduled /compact — new turn will start from compacted context in ~5s." Don't silently fire.

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
