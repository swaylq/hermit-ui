# Global Memory — Progressive Loading (Design)

**Goal:** Make this machine's global memory cost **O(1)** context at session start instead of **O(folder size)**. A small, compressed core stays always-resident; everything else loads through Claude Code's native skill mechanism — the index when the skill triggers, a document when the agent `Read`s it.

**Status:** Proposed (2026-08-07). Extends the shipped global memory (`apps/gateway/src/global-memory.ts`) with the progressive pattern already proven in production by knowledge bases (`docs/knowledge-base-design.md` §3).

---

## 1. The problem

The gateway maintains one managed block at the end of `~/.claude/CLAUDE.md` (`global-memory.ts:64–72`) containing:

1. the inline note (DB, edited in the dashboard), verbatim; and
2. one `@<abs-path>` line per text file under `~/.claude/global-memory/` (`collectImports` 35–60, recursive, ≤200 files).

**Claude Code resolves `@imports` eagerly.** They are not references the model chooses to follow — the file's full text is inlined into the system prompt before the first user turn, in *every* session, for *every* agent on the host. (Direct evidence: any session on this machine shows `secrets-usage.md` reproduced in full in its opening context.)

Measured on this machine today:

| Piece | Chars |
|---|---|
| Inline note | 581 |
| Managed block (note + markers + header + 1 import line) | 830 |
| `secrets-usage.md`, resolved | 1,522 |
| **Always-resident total** | **2,352** (≈0.8k tokens) |

0.8k tokens is affordable. The cost model is not: the folder is explicitly advertised as "somewhere to drop memory notes" (`global-memory.ts:12–13`, `global-memory-files.tsx`), so it grows — and every byte added is paid by every session forever, including one-line ones. Ten 4KB runbooks is ~40KB ≈ 15k tokens of permanent, mostly-unread preamble. There is also no back-pressure in the UI: nothing tells the author that a paragraph they just pasted is now in every agent's head.

The second problem is qualitative. What is resident today is mostly *reference material* (portal URLs, ssh hosts, a CLI's full usage table) — exactly the class of thing an agent should look up when a task needs it, not memorize up front.

## 2. Design — three tiers

Mirror what knowledge bases already do, and let Claude Code's skill loader be the progressive mechanism (no custom retrieval, no new runtime).

| Tier | Lives in | Loaded | Budget |
|---|---|---|---|
| **L0 — core** | the CLAUDE.md managed block: inline note + `always: true` files | always, every session | **≤ ~800 chars, enforced by a UI meter** |
| **L1 — index** | `~/.claude/skills/global-memory/SKILL.md` body: one line per memory file | when the model triggers the skill | ~1 line/file |
| **L2 — content** | the real files under `~/.claude/global-memory/**` | when the agent `Read`s / `Grep`s one | unbounded, free until used |

The skill's `name` + `description` are preloaded by Claude Code for every session — that one sentence (≤200 chars) is the *entire* always-on cost of an arbitrarily large memory folder, and it is what makes the model reach for L1 at the right moment. Everything below it is pull, not push.

## 3. Key difference from knowledge bases: index in place, never copy

For a KB, the **DB** is the source of truth and disk is a materialization, so `knowledge.ts:60–80` writes copies of every doc into `kb-<slug>/docs/`.

For global memory, **the folder on disk is already the source of truth** — the dashboard file manager writes straight into `~/.claude/global-memory/`. Copying the files into the skill dir would create a second copy to keep in sync, a pruner to write, and a drift bug to chase, for zero benefit.

So the generated skill dir contains **only `SKILL.md`**, and its index points at the real absolute paths. One copy on disk. The file manager, the `@import` escape hatch (§5) and the folder layout all keep working untouched.

## 4. Which tier does a given piece of memory belong in?

Skills are **model-triggered**. That is the whole point, and it is also the one real hazard: anything behind a trigger can be missed. So the split is not "short things up top, long things below" — it is:

- **L0 = what an agent must not be able to *not* know.** Identity/machine facts, and hard safety constraints. Today's `secrets-usage.md` "安全铁律" (never echo a secret value into a reply, log, or commit) is exactly this: it must bind an agent that never thought to open the memory skill. Its one-line form belongs in L0; its detailed form stays in L2.
- **L1/L2 = what an agent looks up when the task calls for it.** Portal URLs, host inventories, CLI usage tables, runbooks, API notes.

A useful test for L0: *"if the model has already decided this topic is irrelevant, would being wrong about it be harmful?"* If yes → L0. If it would merely mean a wasted search → L1/L2.

## 5. Per-file metadata — optional frontmatter

The index lines and the always-on override are derived from each memory file itself, with no DB and no LLM, so the "disk is source of truth" property survives and Brain-less machines work identically:

```markdown
---
title: 执楠系统入口          # optional; else first `# H1`; else the filename
summary: cms/pms/gitlab/autodeploy 的地址与登录方式   # optional; else first non-heading line, ≤120 chars
always: true                # optional; keeps this file an eager @import (default false)
---
```

- `always: true` is the **escape hatch**: nothing is silently downgraded, and any file can be pinned back to L0 per-file. It counts against the L0 meter (§7).
- Frontmatter is stripped from the index rendering but left in the file (harmless when the agent reads it).
- A file with no frontmatter still gets a usable index line — this design requires no edits to existing memory files to start working.

## 6. The generated skill

`~/.claude/skills/global-memory/SKILL.md` — machine-global, so every Claude Code session on the host discovers it (same discovery path as global skills, `global-skills.ts:21`):

```markdown
---
name: global-memory
description: "Shared memory for this machine: GitHub 账号; 常用主机与 ssh; secret CLI — 统一凭据的读写; 执楠系统入口与账号. Consult it before asking the user for an account, URL, host, path, credential or local convention, and whenever a task touches one of the topics listed here."
hermit_kind: memory
---
# Global Memory — <machine>

Shared notes for every agent on this machine. Read the specific file below rather
than answering from memory; the paths are absolute and readable as-is.

Documents:
- `/Users/mac/.claude/global-memory/github.md` — GitHub 账号 · 账号 swaylq；token 在 secret store 的 GITHUB_TOKEN_SWAYLQ
- `/Users/mac/.claude/global-memory/hosts.md` — 常用主机与 ssh · zhinan-main / japan-dev 的 ssh 命令，以及各自 sudo 密码所在的 secret key
- `/Users/mac/.claude/global-memory/secrets-usage.md` — secret CLI — 统一凭据的读写 · 怎么读、怎么写、安全铁律、现有 key 清单
- `/Users/mac/.claude/global-memory/zhinan-systems.md` — 执楠系统入口与账号 · cms / pms / autodeploy / gitlab 的地址与对应 secret key
```

- `description` is the always-resident sentence — the only part of an arbitrarily large folder that every session pays for. It must say **what is inside + when to consult it**; one that only names the topic will not fire at the right time. The topic list is capped so the whole sentence stays ~250 chars.
- The machine's hostname appears in the body heading but **not** in the description: it tells the model nothing it doesn't already know from being on the machine, and description bytes are rent.
- `hermit_kind: memory` is the exclusion marker (§7), matching `hermit_kind: knowledge`.
- Rendering is deterministic from a folder scan, so the writer is idempotent.

## 7. Changes

### `apps/gateway/src/global-memory.ts`

- `collectImports()` → returns only files whose frontmatter has `always: true`. Everything else becomes an index entry instead of an import.
- New `renderMemorySkill(entries)` + `materializeMemorySkill()`: scan the folder (reusing the existing recursive walk), parse each file's frontmatter/H1/first-line, render `SKILL.md`, and write it **only if the content differs** from what is on disk — preserving today's "a no-op tick never rewrites the file" property (`global-memory.ts:101`).
- `description` is **generated** from the indexed files' own titles plus a fixed "consult it when…" clause. No second place to edit and no schema change: the note stays the only hand-written always-on text, and the description tracks the folder by itself. (A hand-authored override is deferred — §13.)
- **Disabled or empty folder** → remove `~/.claude/skills/global-memory/` entirely, alongside dropping the block (today's `enabled` branch, 97–99).
- **Never clobber a human skill:** if `~/.claude/skills/global-memory/SKILL.md` exists *without* `hermit_kind: memory`, skip and log. Same posture as the KB pruner (`knowledge.ts:48–56, 197`).
- Runs inside the existing 30s tick (`index.ts:260`) and the startup pass (`index.ts:219`) — no new loop.

### `apps/gateway/src/global-skills.ts`

- `probe()` line 155 currently returns `null` for `hermit_kind === 'knowledge'`. Extend to `'memory'` so the generated skill never appears in Settings → Global Skills (and therefore can never be edited or deleted from there, only from the Memory page).

### `apps/dashboard` — the compression pressure

The mechanism alone does not compress the note; the UI has to make the cost visible at authoring time.

- **Note budget meter** in `global-memory-files.tsx`: a live `NNN / 800 chars always-on` readout on the note editor, amber past the budget, with a line saying what to do about it ("keep identity and hard rules here; move reference material into a file — files are indexed in the `global-memory` skill and read only when needed"). The note is the machine's only hand-written always-on text and the thing that grows, so this is the piece that actually delivers "压缩一下初始的话".
- Update the page's subtitle (`app/global-memory/page.tsx:37–40`): note → `~/.claude/CLAUDE.md` (always on); files → indexed as the `global-memory` skill, read on demand.
- **Deferred:** a per-file `lazy`/`always` badge + toggle in the tree. The tier lives in each file's frontmatter, and the tree only has metadata (name/size/mtime) — a badge would need a content fetch per file. Until then `always: true` is set by editing the file in the same explorer, and the pinned count is visible in the gateway's sync log.

### Data model

None. Everything except the note is derived from disk — no schema change, no migration, so this ships with a gateway restart and does not need a VPS deploy to take effect.

## 8. Concrete migration of this machine's memory (done 2026-08-07)

The design's payoff, applied to what was actually in `~/.claude/CLAUDE.md` (§1).

**L0 — the inline note, 240 chars (from 581 + a 1,522-char eager import):**

```markdown
凭据一律走 `secret` CLI：**绝不** echo、绝不写进回复/日志/commit，用 `secret exec KEY -- <命令>` 注入；不确定某 key 在不在就 `secret list`，不在就问 sway，别自己去文件系统爬 token。

执楠系统入口与账号、常用主机 ssh/sudo、github、secret 用法明细 → 读 `global-memory` skill 的索引（文件在 `~/.claude/global-memory/`）。
```

Two things only: the one hard rule that must bind an agent that never opens the memory skill, and a pointer. Everything else moved down.

**L2 — the folder:**

| File | From |
|---|---|
| `zhinan-systems.md` | cms / pms / autodeploy / gitlab URLs + their account/password key names |
| `hosts.md` | `zhinan-main` (139.198.179.233:221), `japan-dev` (45.89.234.110) + each one's sudo key |
| `github.md` | account `swaylq` + `GITHUB_TOKEN_SWAYLQ` |
| `secrets-usage.md` | unchanged content; gained `title`/`summary` frontmatter so its index line reads well |

Splitting into four small files rather than one grab-bag is deliberate: under progressive loading the index line is what gets scanned, so a focused file with a sharp one-liner is *cheaper* to have than a broad one — the cost of an extra file is one line, and the payoff is the agent reading only what it needs.

**Result:** always-on **2,352 → 682 chars**, a **71% cut**. Measured the same way on both sides — the whole managed block including its markers and header (830 → 438) plus what it pulls in with it (a 1,522-char resolved `@import` → a 244-char skill description). The note itself is 581 → 240.

The cut is the smaller half of the win. The other half is that it is now **flat**: the fifth and the fiftieth memory file each cost one index line, paid only when the skill fires.

## 9. Edge cases

- **Empty folder** → no skill dir; block is the note alone (today's behaviour exactly).
- **Toggle Off** → block dropped *and* skill dir removed; files and DB untouched.
- **Nested folders** → index shows the path; the existing recursive walk is reused, ≤200 entries (`MAX_IMPORTS`).
- **`.txt` / `.markdown`** → same handling as today (`IMPORTABLE` 26).
- **Huge file** → no longer a problem worth guarding: it is not loaded until read. The 64KB read caps in the skill collectors do not apply, because the file is never collected — only its path is.
- **Pre-existing user skill named `global-memory`** → detected by the missing marker; the gateway skips and logs rather than overwriting.
- **Two machines** → per-machine as before; each gateway writes its own host's skill.
- **A stale skill after downgrade** (gateway rolled back) → the old code ignores `~/.claude/skills/global-memory/`, so the skill lingers and the imports come back: memory is duplicated, never lost. Deleting the dir is the manual undo.

## 10. Verification

No unit-test harness here (repo convention) — verify by `tsc --noEmit` + `npm run build:check` + runtime:

1. Drop three files in `~/.claude/global-memory/`; within 30s `~/.claude/skills/global-memory/SKILL.md` lists three index lines, and the CLAUDE.md block contains the note with **no** `@import` lines.
2. A fresh session on the machine: `/context` shows the drop; the skill is listed with its description.
3. Ask something answerable only from a memory file → the agent triggers the skill and reads that file (and *only* that file).
4. Add `always: true` to one file → its `@import` returns on the next tick and the meter goes up.
5. Toggle Global Memory **Off** → block gone, skill dir gone; **On** → both return.
6. Settings → Global Skills does **not** list `global-memory`.
7. Idempotence: two ticks with no change leave `SKILL.md` mtime untouched.
8. Put a hand-written `SKILL.md` without the marker at that path → gateway logs a skip and does not overwrite it.

## 11. File-change map

**Modify**
- `apps/gateway/src/global-memory.ts` — frontmatter parse, `always` filter, skill renderer + writer, disable/empty cleanup, human-skill guard (§7).
- `apps/gateway/src/global-skills.ts` — exclude `hermit_kind: memory` in `probe()` (line 155).
- `apps/dashboard/src/components/global-memory-files.tsx` — note budget meter + over-budget hint (§7).
- `apps/dashboard/src/app/global-memory/page.tsx` — subtitle.

**No new files, no schema change.** The gateway module, the tick, and the UI page all already exist; this is an extension of the shipped feature, not a parallel one.

Rollout: the gateway does all the work, so a per-machine **restart** (`pm2 restart hermit-ui-gateway`) is the whole deploy — Mac + both macminis. The dashboard edits are cosmetic and ride along on the next VPS deploy; nothing waits on them.

## 12. Rejected alternatives

- **Nested `@imports`** (CLAUDE.md imports one index file that imports the rest): Claude Code resolves imports recursively and eagerly (up to 5 hops), so the whole tree still lands in the prompt. No saving.
- **Move memory files into a knowledge base**: KBs are DB-sourced and per-agent *attach*; global memory is disk-sourced and machine-wide-by-default. Wrong shape, and it would cost the file-manager authoring UX. (The two could converge later — a machine-wide KB attach would make global memory a KB with `machineWide: true`. Out of scope.)
- **An MCP tool that lists/reads memory**: a tool definition is itself always-on context, plus a runtime dependency and a round-trip per read. The skill loader does this natively for free.
- **A "compress the note" LLM pass at write time**: destroys the author's exact wording (these are credentials-adjacent operational rules). The meter pushes the human to make the call instead.

## 13. Out of scope (v1)

- A hand-authored override for the skill `description` (today it is always generated from the file titles), and the Brain-authored refresh above it (the KB `autoIntro` pattern applies verbatim; add `memory_set_description` to the brain tools later).
- A per-file `lazy`/`always` badge + toggle in the file tree (§7).
- Per-agent global-memory overrides.
- Cross-machine memory sharing.
- Usage telemetry (which memory file actually gets read) to drive tier suggestions.
