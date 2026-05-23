# evolution/

Project-level lessons learned the hard way. Each long task that fails leaves behind a one-page postmortem here. Future iterations of the loop task read this before picking the next item, so the same wall doesn't get hit twice.

Inspired by Hermes Agent's [self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) approach (GEPA: read execution traces → identify _why_ failures happen → produce reusable mutations), but stripped to markdown — no DSPy, no genetic optimizer, no embedding store. Just notes.

## Files

- `lessons.md` — short, indexable list of distilled failure root-causes. Each entry: title, what failed, why it failed, how to avoid. ≤200 lines total; evict the oldest/least-relevant when full.
- `postmortems/YYYY-MM-DD-<slug>.md` — long-form writeups for failures worth more than a paragraph. Linked from `lessons.md`.
- `skills/<verb>.md` — codified procedures the agent or loop figured out. SKILL.md-style: heading + steps + caveats. ≤15KB each.

## How loop iterations use this

Each `LOOP_TASK.md` iteration prompt instructs the agent to:

1. Read `lessons.md` first
2. Pick highest-impact PENDING item from `LOOP_TASK.md`
3. If the work touches an area covered by a lesson, follow the lesson's "How to avoid" before writing code
4. On failure: distill into a new lesson entry + (if substantial) a postmortem file; mark the LOOP item as BLOCKED with a pointer to the lesson

## Difference from per-agent `<agent>/evolution/`

This `evolution/` (under `hermit-ui/`) tracks **the project's** failures — gateway code went wrong, dashboard regression, build broke.

Each agent has its OWN `evolution/` under its workspace tracking **that agent's** drift — persona evolution, learned skills for its specific user, daily reflections. The two don't share content.
