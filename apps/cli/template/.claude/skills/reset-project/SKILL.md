---
name: reset-project
description: Archive project-specific memory while keeping evergreen lessons. Use when the user says "重置项目记忆", "归档项目", "项目结束", "切换项目", "reset project", "archive project", or "graduate". After a project ships, this clears project context so the agent starts fresh on the next similar project, without losing reusable lessons.
user_invocable: true
---

# Reset Project Memory

After finishing a project (a deck, a research cycle batch, one brand audit, a feature ship — whatever), this skill archives project-specific memory so it stops loading into context. Evergreen content (user preferences, tool tips, cross-project patterns) stays loaded; one-time project details get filed away. The agent comes out clean for the next project of the same type.

## When to Use

User says any of: 重置项目记忆 / 归档项目 / 项目结束 / 切换项目 / reset project / archive project / graduate.

Typical trigger: agent finished a project (deck shipped a PPT, humanize wrapped a research cycle, brandguard finished one brand audit), and is about to start a new project of the same type.

## Arguments

- `label` (optional, default `reset-<YYYY-MM-DD>`): name for the archive folder. Use a meaningful project label when it aids future retrieval; otherwise let the date default fill in.

## Procedure

### Phase 1 — Inventory

Catalog current memory in two stores:

1. **Workspace memory** at `<workspace>/memory/`:
   - All `memory/YYYY-MM-DD.md` daily logs.
   - `MEMORY.md` index entries.
   - Each curated file linked from `MEMORY.md` (typically `memory/<topic>.md`).

2. **Auto-memory** at `~/.claude/projects/-Users-mac-claudeclaw-<agent>/memory/`:
   - Same structure: `MEMORY.md` index + per-topic files.

Just gather paths; don't classify yet.

### Phase 2 — Classify (autonomous, no user gate)

For each memory unit, decide EVERGREEN or PROJECT-SPECIFIC.

**EVERGREEN — keep loaded:**
- User feedback / preferences (auto-memory `feedback_*.md` naming).
- Tool / infrastructure references (`reference_*.md`).
- Cross-project patterns: bug shapes, anti-patterns, workflow lessons.
- Anything stating "user prefers …", "general pattern …", "always do X when Y".

**PROJECT-SPECIFIC — archive:**
- Daily logs detailing one project's tasks, commits, debugging.
- Curated entries naming specific files, functions, or business logic of one project.
- Debug write-ups tied to one codebase's particular state.
- Anything where a single project is the primary subject.

When unsure: **archive**. Safer to file away than to leak old project context. Archive is recoverable.

### Phase 3 — Archive (move, never delete)

Create archive root:

```
<workspace>/memory/archive/<label>/
  daily/         # moved from workspace memory/YYYY-MM-DD.md
  curated/       # moved from workspace memory/<topic>.md
  auto-memory/   # moved from ~/.claude/projects/<agent>/memory/<entry>.md
  README.md      # one line: "<label> archive, created <YYYY-MM-DD>"
```

Use `mv` for every file. Then:
- Remove archived entries from workspace `MEMORY.md` index.
- Remove archived entries from auto-memory `MEMORY.md` index.

The archive is self-contained and recoverable: `mv` it back if needed.

### Phase 4 — Distill

Read everything just archived. Extract reusable lessons:
- Bugs encountered + the underlying pattern (not the specific fix).
- Process / workflow lessons (what worked, what didn't, what to do differently next time).
- Tooling discoveries.
- Re-confirmed user preferences.

Write the full distillation to `<workspace>/memory/lessons-from-<label>.md` (note: at workspace `memory/` root, NOT inside `archive/` — it must be loadable). Each lesson: 1-3 lines, lead with the rule, optional **Why:** line, optional **How to apply:** line.

Then update indexes so the lessons are reachable on next session:

1. **Workspace `MEMORY.md`** — add an index pointer line:
   `- [Lessons from <label>](memory/lessons-from-<label>.md) — N reusable lessons from past project`

2. **Top 1-3 promotion (inline)** — pick the 1-3 most cross-cutting lessons and add full entries directly to `MEMORY.md` (not just pointers — full content, ~3-5 lines each), tagged `(from <label>)`. These are loaded verbatim every session, no follow-up read needed.

3. **Auto-memory `MEMORY.md`** at `~/.claude/projects/-Users-mac-claudeclaw-<agent>/memory/MEMORY.md` — mirror the same pointer line and the top 1-3 inline entries.

Promotion criteria for the inline 1-3: lesson generalizes beyond this project type AND would shape the agent's behavior next time. Bug-fix recipes don't promote; pattern-level insights do.

### Phase 5 — Report

Telegram reply summarizing:
- N daily logs archived
- M curated entries archived
- K auto-memory entries archived
- L lessons distilled into `memory/lessons-from-<label>.md`, P promoted inline to MEMORY.md
- Archive path: `<workspace>/memory/archive/<label>/`

Done. Next session loads only evergreen content + the new lesson pointers/promotions.

## Defaults

- **Label**: `reset-<YYYY-MM-DD>` (today's date).
- **Archive root**: `<workspace>/memory/archive/<label>/`.
- **Lessons file**: `<workspace>/memory/lessons-from-<label>.md` (sibling of archive/, not inside it — must be loadable).
- **Auto-memory root**: `~/.claude/projects/-Users-mac-claudeclaw-<agent>/memory/`.

## Important Notes

- **Move, never delete.** `mv` always; never `rm`. Recoverable beats gone forever.
- **Archive aggressively.** Tie goes to archive. Evergreen content lives in `feedback_*` / `reference_*` patterns and explicitly cross-project lessons; everything else is project-specific by default.
- **Don't touch code or git.** This skill operates only on memory directories. Workspace code, scripts, `.claude/` configs, and git state are untouched.
- **No user confirmation gate.** sway authorized autonomous archiving (2026-05-05). Don't list classifications and ask — classify and execute.
- **Lessons file lives OUTSIDE archive.** Putting `lessons-from-<label>.md` inside `archive/` would mean it never gets loaded — defeating the point. It must live at `memory/` root and be indexed in `MEMORY.md`.
- **Update both indexes.** Workspace `MEMORY.md` AND auto-memory `MEMORY.md`. Stale pointers to archived files break the next session's grep; missing lesson pointers waste the distillation.
- **Idempotent re-run.** If sway runs reset-project twice in a day, the second invocation should land in `<label>-2/` (and `lessons-from-<label>-2.md`) — don't clobber the first archive. Auto-suffix on collision.
