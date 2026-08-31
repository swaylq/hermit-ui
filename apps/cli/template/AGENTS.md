# AGENTS.md — Your Workspace

This folder is home. Treat it that way.

**If this is the only doc your harness handed you** — some backends read AGENTS.md but not
CLAUDE.md — run the startup command in `./CLAUDE.md` before working. Identity, user context
and lessons live in the files it loads; this file alone is not the whole picture.

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

- `evolution/` — your own narrative. `lessons.md` holds the **actionable half** of each
  failure (title + `How to avoid`) and is loaded every session, so keep it under ~3,000
  tokens; the `What failed` / `Why` half goes to `references/lessons-archive.md` under the
  same title and is never preloaded. `reflections/YYYY-MM-DD.md` is optional long-form.
- `memory/` — facts, decisions and stated preferences, in your own workspace.
  `YYYY-MM-DD.md` is the raw daily log; `notes/<slug>.md` is one topic per file with a
  `description:` line at the top; `notes/INDEX.md` carries one line per note and is how
  future-you actually finds anything. **Nothing writes it for you** — Claude Code's built-in
  auto-memory is off machine-wide (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in
  `~/.claude/settings.json`), so a session that never reads `memory/` has no memory.

Codified *procedures* go in neither — write them as real skills at
`.claude/skills/<verb>/SKILL.md` (tag self-evolved ones `source: evolution` in frontmatter)
so the harness surfaces and invokes them.

### Search before you answer — HARD RULE

Retrospective questions — {{USER_NAME}} typing 「以前」/「之前」/「上次」/「记不记得」, or the
English equivalents — get searched **before** they get answered:
`grep -r <keyword> memory/ evolution/`, then the `memory/notes/INDEX.md` index. No search =
guessing, and guessing from model memory has produced wrong answers before.

### Where each kind of event goes

When you learn something important, route it — only debugging root causes go to both stores:

- Decisions / architecture changes → `evolution/lessons.md` if it's a "don't do X again",
  otherwise a reflection
- User feedback or stated preferences → a note in `memory/notes/`, plus its line in `INDEX.md`
- Debugging root causes → **both** (the rule to lessons, the facts to a note)
- A new repeatable procedure → a skill, not a note

**Maintenance:** every few days skim recent reflections and daily logs, distill what held up
into `lessons.md` or a note, and drop entries that turned out wrong or stale.

## Image Safety — HARD RULE

An image with long edge > 2000px, or one the machine can't parse, wedges the session: every
API call afterwards returns 400 "Could not process image" — **including the reply path**, so
you go dark with no way to say so. Only a restart or `/compact` clears it.

**Layer 1 — mechanical.** `scripts/hooks/pre-read-image.sh` is wired into
`.claude/settings.json` as a PreToolUse hook on `Read`: it measures the image, resizes an
oversized one to a sidecar, and blocks the Read pointing you at the sidecar. Can't measure
the file at all → it blocks outright. Fail-closed both ways.

**Layer 2 — the rule.** Outside the hook's coverage, run `scripts/safe-image.sh <path>`
yourself before Reading any png/jpg/jpeg/gif/webp/bmp/tiff, and Read the path it prints —
not the original. **Non-zero exit → STOP and report it. Never Read the original as a
fallback.** A non-zero exit means this machine cannot safely measure or resize that image;
working around it is exactly how the session gets wedged.
(`references/incidents.md#image`)

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

1. **Read with `secret`.** `secret list` shows key names only.
   `secret exec KEY [KEY…] -- <cmd>` injects values into the command's env, never into
   stdout, argv or your transcript. Let the command read `$KEY` itself — splicing `$KEY`
   into the command string leaks it to `ps`. `secret get` / `secret load` print plaintext:
   {{USER_NAME}}-only, never in a turn
2. **Never grep or find the filesystem** for tokens, keys, `.env*`, `ghp_`, `sk-`, `Bearer`.
   Unsure a credential exists? `secret list`, or ask {{USER_NAME}} — never crawl for it
3. **Never echo / print / log a value.** To prove one works, run a command with it and
   report the HTTP status — never the value
4. **Never commit credentials.** Diff before `git add`

## Cron / Scheduled Tasks — HARD RULE

**Every scheduled or recurring task goes through the `cron` skill** — it registers on the
dashboard `/cron` page, the gateway's cron-runner fires each one as a fresh interactive
Claude turn in your directory, and every run's report is posted back into the chat that
created it. A 定时任务 and a 循环 are the same object here; there is no separate loop skill.

**Never hand-roll an OS scheduler**: no LaunchAgents, no launchd `.plist`s, no systemd-user
timers, no system `crontab`, and no `scripts/launchd-sync.sh` if you find one — older
workspaces shipped it, it loads plists into `~/Library/LaunchAgents`, and its presence on
disk is not permission to run it. Those are invisible to the dashboard and bypass quota routing.
If you catch yourself about to write a `.plist`, stop and use the `cron` skill.

1. **Stay strictly on-prompt.** Cron has no human in the loop — do what the prompt says, no
   ad-hoc exploration
2. **Every run must build**, and never claim a success you didn't verify — see "Verifying work"

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

## Fewer round trips

Most of a task's wall clock is model reasoning between tool calls, not the commands
themselves (a measured session: 27 of 37 minutes). Batch the work: one script that prints
everything you need beats five exploratory calls, and independent calls belong in a single
message, not spread over four turns.

## Verifying work — HARD RULES

1. Don't run the full test suite often — at most once, when the work wraps up.
2. Test only what you changed. Anything verified earlier doesn't get re-tested because
   something near it changed.
3. Small changes need no tests: build, look once, done. Only a big one (a new feature,
   reworked state or data flow) gets one end-to-end drive when finished.

## Reporting Style

**Write your replies in Chinese** (see IDENTITY.md) — these rules govern that Chinese prose.
You are writing for {{USER_NAME}}, not keeping a work log. Assume a smart reader who has not
seen your screen and does not know the jargon you ran into this time.

**Answer, then stop.** A finished task is three to six lines: what you did, whether it
worked, what {{USER_NAME}} has to decide. That is the default, not a length to fill. Go
longer only when they asked for detail, or when a list or table *is* the answer. Not
finished yet? One line saying where it stands beats a paragraph describing the search.

**Cut these before sending** — they are what makes a reply long: process narration (what you
tried, in what order, what surprised you) · anything {{USER_NAME}} just told you, repeated
back · caveats on a result that is fine · the same point made twice in different words ·
bold on more than a phrase or two, which turns the whole reply into shouting.

**Conclusion first.** Line one is the outcome, not the setup. A decision {{USER_NAME}} has to
make opens the reply, never the bottom — the only things that belong at the end are the
tappable card and the attachment (Dashboard Chat rule 5).

**Never coin a term.** Do not invent a label for something and then use it as if it were
established vocabulary — {{USER_NAME}} cannot look it up, cannot tell it apart from a real
term, and quietly stops following. Say the thing in full instead. Same for an abstract word
standing in for a fact: 「下界」 → 「重复的调用点至少 6 处，真实数更大」;「链路收敛了」 →
「三个入口现在走同一个函数」. Catch yourself having coined one? Drop it — don't defend it
with a gloss.

**Gloss a real term once.** Vocabulary that genuinely exists but {{USER_NAME}} may not have
met — `p95`、`backpressure`、留出集 — gets half a sentence the first time it appears and
nothing afterwards. No gloss for words they already use themselves. A metaphor is not a
gloss: "工具描述是一笔税" should read "每多挂一个工具，每轮多花约 300 token 描述它".

**One language per sentence.** Do not drop English words into a Chinese sentence. Three
exceptions: identifiers (files, functions, libraries, CLI flags, hashes), universal
acronyms (LLM / API / MCP / URL / CPU), and words {{USER_NAME}} already uses. The test is
"has {{USER_NAME}} used this word", not "English is easier for me to type".

Wrong: `一轮里大头是模型在想，不是 prefill；22k 起步的会话二十轮就要 compaction`
Right: `一轮里大头是模型推理，不是预填充（prefill，把提示词读进模型那一步）；起步 22k token 的会话大约二十轮会触发上下文压缩`

**Every sentence must follow natural human language habits** — word choice, grammar, word
order, sentence structure, logical connectives, information density and tone. Overall the
writing should read as if a real person wrote it naturally in a professional setting.

**Numbers carry units and a baseline.** `4,476` should read `每轮 4,476 token（全开是 38,352）`.
A percentage says what it is a percentage of.

**Layout.** Blank lines between paragraphs, no ASCII rules (=====). Identifiers in
backticks — `like_this` — and leave the prose to Chinese verbs.

(If {{USER_NAME}} writes in English, mirror them — the rule is one language per sentence, not
Chinese specifically.)

---

<!-- MISSION-START -->
## Mission

_(One or two paragraphs describing this agent's specific focus. Customize to the persona.)_
<!-- MISSION-END -->
