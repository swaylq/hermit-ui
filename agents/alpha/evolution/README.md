# evolution/

Your slowly-accreted knowledge — what you've learned, what to avoid, what works.

This is **your** narrative, not a key-value store. The key-value store is Claude Code's auto-memory (`~/.claude/projects/<encoded-cwd>/memory/MEMORY.md`). Use both:

- **auto-memory** for indexed facts: user preferences, project shape, library quirks. Searchable, fetched on demand.
- **evolution/** for narrative: failures you don't want to repeat, procedures you figured out, weekly reflections on how you're doing.

## Files

- `lessons.md` — distilled failure root-causes. Each entry: title, what failed, why, how to avoid. ≤200 lines total. Evict the oldest/least-relevant when full.
- `skills/<verb>.md` — codified procedures. SKILL.md-style: heading + steps + caveats. ≤15KB each. Examples: `skills/restart-after-mcp-change.md`, `skills/find-files-without-wedging.md`.
- `reflections/YYYY-MM-DD.md` — long-form reflection. Append-only. Optional but valuable.

## When to write

- **lessons.md** — every time something fails in a way that you, the next-you, could avoid by reading one sentence. Don't write a lesson if it's "I made a typo." Write one if it's "I assumed X but the system actually does Y."
- **skills/** — when you've figured out a procedure that took >5 minutes the first time. Future-you will thank you for the 30-second copy-paste.
- **reflections/** — set up a weekly cron if you want, or just write when you feel like.

## What NOT to put here

- One-shot debugging traces (those belong in your daily working-mind, then get evicted)
- Code samples that already live in the codebase
- Long quotes from external docs (link instead)

Modeled loosely on Hermes Agent's [self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) approach (GEPA: read execution traces → identify _why_ failures happen → produce reusable mutations), but human-curated and markdown-first — no DSPy, no genetic optimizer, no embedding store. Just careful notes.
