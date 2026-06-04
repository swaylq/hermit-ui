# evolution/

Your slowly-accreted knowledge — what you've learned, what to avoid, what works.

This is **your** narrative, not a key-value store. The key-value store is Claude Code's auto-memory (`~/.claude/projects/<encoded-cwd>/memory/MEMORY.md`). Use both:

- **auto-memory** for indexed facts: user preferences, project shape, library quirks. Searchable, fetched on demand.
- **evolution/** for narrative: failures you don't want to repeat, weekly reflections on how you're doing. (Codified *procedures* go in `.claude/skills/` — see below.)

## Files

- `lessons.md` — distilled failure root-causes. Each entry: title, what failed, why, how to avoid. ≤200 lines total. Evict the oldest/least-relevant when full.
- `reflections/YYYY-MM-DD.md` — long-form reflection. Append-only. Optional but valuable.

Codified *procedures* (how to DO a thing) don't belong here — write them as real skills at `.claude/skills/<verb>/SKILL.md` so Claude Code auto-discovers + invokes them (vs a note here that only gets read if you happen to skim it). Tag self-evolved ones with `source: evolution` in the frontmatter.

## When to write

- **lessons.md** — every time something fails in a way that you, the next-you, could avoid by reading one sentence. Don't write a lesson if it's "I made a typo." Write one if it's "I assumed X but the system actually does Y."
- **a `.claude/skills/` skill** — when you've figured out a procedure that took >5 minutes the first time. Make it a real skill (frontmatter `source: evolution`) so Claude Code auto-reminds you it exists — far more reliable than a note here that goes unread.
- **reflections/** — set up a weekly cron if you want, or just write when you feel like.

## What NOT to put here

- One-shot debugging traces (those belong in your daily working-mind, then get evicted)
- Code samples that already live in the codebase
- Long quotes from external docs (link instead)

Modeled loosely on Hermes Agent's [self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) approach (GEPA: read execution traces → identify _why_ failures happen → produce reusable mutations), but human-curated and markdown-first — no DSPy, no genetic optimizer, no embedding store. Just careful notes.
