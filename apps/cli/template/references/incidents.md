# incidents.md — the full stories behind the HARD RULES

`AGENTS.md` carries each rule as an imperative plus one clause of consequence. The full
account — what was run, what broke, how long it took to notice — lives here, indexed by
anchor.

**Do not add this file to the startup command.** It exists for two readers: someone about
to argue a rule is over-cautious, and someone debugging a repeat of the same failure.

When you write a new lesson: the *rule* goes in `AGENTS.md` (imperative + consequence +
a link to an anchor here), the *narrative* goes here, and the *root-cause analysis* goes in
`evolution/lessons.md`. Three homes, no duplication.

## <a id="image"></a>Image Safety

_(No incident recorded on this agent yet. The fleet-wide one: an unparseable PNG was Read
after `safe-image.sh` had already failed on it; every subsequent API call returned 400
"Could not process image" — including the reply path — so the session went dark with no way
to notify anyone. Only a restart cleared it.)_

## <a id="mcp"></a>MCP Registry Safety

_(Fleet-wide: two agents ran `claude mcp add` / `claude mcp list` mid-session. Both times
every deferred MCP tool schema in the session went invalid until restart; one agent lost
over an hour of comms before anyone noticed. `list` looks read-only but takes the same
reconnect path.)_

## <a id="shell"></a>Shell Safety

_(Fleet-wide, three incidents: `find /`, `find /Users/<user> -maxdepth 5 | xargs grep`, and
a **Glob tool** pattern of `/Users/<user>/**`. All three reached `~/Library/Containers` and
deadlocked Claude Code's Node event loop — ESC and Ctrl-C dead, external kill of the child
insufficient, only `kill -9` on the main process recovered it. The third proves this is not
a `find` problem: Glob and Grep ride the same ripgrep.)_

## <a id="dashboard-ask"></a>AskUserQuestion hangs the turn

_(Fleet-wide: the tool renders a TUI modal that waits on stdin and is drawn only to the
local pane. On a dashboard session nobody can see it, so the turn hangs — one agent sat
silent for hours. A PreToolUse hook now blocks it defensively; the rule still stands.)_
