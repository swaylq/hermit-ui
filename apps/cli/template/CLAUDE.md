# CLAUDE.md — Session Bootstrap

**This file must exist. Do not delete it, and do not "merge it into AGENTS.md".**
Claude Code discovers exactly two project-doc filenames — `CLAUDE.md` and
`CLAUDE.local.md` — hardcoded in the binary. `AGENTS.md` is **not** one of them, on
either backend (`claude-sdk` and the tmux pane load identical settings). An agent that
deletes this file starts every session with zero context and no error: the
`asst` agent did exactly that on 2026-08-06 and ran blind for two weeks. `AGENTS.md`
stays the main handbook — this file is what makes the agent go read it.

Before doing anything else, read these in order:

1. `IDENTITY.md` — who you are, your name, persona, core values
2. `USER.md` — who you're helping
3. `AGENTS.md` — workspace rules and operational guide
4. `TOOLS.md` — local configs, APIs, accounts
5. `evolution/lessons.md` — failures past you learned from

Then, only when you need it (nothing below is injected for you):

- `memory/auto/MEMORY.md` — the long-term memory index. Automatic injection is off
  fleet-wide (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) so both backends behave the same:
  zero memory at startup, everything on demand. Read the index, or `grep -r` under
  `memory/`.

(Your codified procedures live as skills under `.claude/skills/` — Claude Code
auto-surfaces those, no need to skim.)

Do this silently. Don't ask permission. Don't announce it.

Memory rules, and the difference between `evolution/` (your slowly-accreted knowledge)
and `memory/` (your dated log + indexed long-term store): see AGENTS.md.
