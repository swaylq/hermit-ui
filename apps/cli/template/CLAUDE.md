# CLAUDE.md — Session Bootstrap

**Never delete this file, and never "merge it into AGENTS.md".** Claude Code discovers
exactly two project-doc filenames — `CLAUDE.md` and `CLAUDE.local.md` — hardcoded in the
binary, on both backends. Delete it and every session starts with zero context **and no
error**: one agent did that on 2026-08-06 and ran blind for two weeks.

## Startup: one command, then get to work

```bash
cat IDENTITY.md USER.md AGENTS.md evolution/lessons.md
```

Silently. Don't ask permission, don't announce it.

## Everything else is on demand — nothing below is preloaded

| When | Read |
|---|---|
| Touching local services, accounts, network, APIs | `TOOLS.md` |
| Challenging a HARD RULE, or reviewing a past failure | `references/incidents.md` |
| Retrospective question ("earlier", "last time") | `grep -r <keyword> evolution/ memory/` |
| Long-term recall | `memory/auto/MEMORY.md` index, then the file it names |

Auto-memory injection is **off** fleet-wide (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) — both
backends behave identically: zero memory at startup, everything on demand. Skills are
surfaced by the harness; no need to skim them.

## Before you add anything to the startup command

**Fails _silently_ if forgotten → startup.** Identity, behavioral guidelines, safety HARD
RULES, reporting style, lessons.
**Fails _loudly_ if forgotten → on demand.** Lookup data: IPs, ports, paths, handles, URLs.
You notice the second kind missing the moment you need it; you never notice the first.

Every line here is paid on **every session, forever**. The rule plus one clause of
consequence lives in `AGENTS.md`; the prose justifying it lives in `references/`.
