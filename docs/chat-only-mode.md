# Pure-chat mode

A session ticked **Pure chat** in the new-chat form spawns its child with a
read-only tool surface: it can look at files and search the web, it cannot
write, edit, run commands or spawn sub-agents. `ChatSession.chatOnly`, default
false, decided when the session is opened.

The point is a fast conversational turn — analysis and an opinion, no side
effects. That is why every backend that can do so **removes** the tools rather
than refusing them per call: a tool the model cannot see is a tool it does not
spend a round trip trying.

## There is no shared mechanism, and that is the whole story

Not one backend's write tools are forwarded by the gateway. `bash`, `write`,
`edit`, `apply_patch`, `ipython` — all of them ship inside the CLI we spawn. So
"turn off writing" is eight different switches, listed in
`apps/gateway/src/runtime/chat-only.ts` and applied by each runtime.

| backend | how the tools are cut | can it record? | verified |
|---|---|---|---|
| claude-sdk | SDK `tools: [...]` — narrows the built-in set | ✅ `memory_write` (MCP) | ✅ read the `init` event's tool list back |
| claude-tmux | `--tools Read,Grep,…` | ✅ `memory_write` (MCP) | ✅ same, plus coexistence with `--dangerously-skip-permissions` |
| codex | `sandboxMode: 'read-only'` — an **OS-level** sandbox (seatbelt / landlock), the hardest of the eight | ✅ `memory_write` (MCP) | ✅ flag exists in the SDK's own types + CLI help |
| pi | `--tools read,grep,find,ls`, unioned with hermit's extension tools | ✅ `memory_write` (extension) | ✅ pi's own docs give this exact recipe; the shipped `scout` mode already uses it |
| omp | `--tools <read-only subset of its 31 built-ins>`, **not** unioned | ✅ `memory_write` (extension) | ✅ union would hard-error the spawn; documented in `pi-modes.ts` |
| dsh | write/exec plugins removed from the `--patch` composition, **plus** `DSH_PERMISSION_MODE=read-only` | ❌ no hermit tool surface at all | ⚠️ plugin removal uses a mechanism this file already relies on; the `read-only` enum value is **unverified** — see below |
| kimi | an agent profile in `KIMI_CODE_HOME`, bound with `--agent-file` on the first turn and restored automatically on resume | ❌ no hermit tool surface at all | ⚠️ tool names read out of the installed CLI; the profile itself is unverified end to end |
| prime | `--tools <hermit extension tools only>` — which removes its single built-in | ✅ `memory_write` (extension) | ✅ trivially, and uselessly — see below |

### There are TWO hermit tool surfaces, not one

Easy to get wrong, and worth stating plainly because a first pass at this
feature got it wrong:

- **MCP stub** (`mcp-stub.cjs`) — claude-sdk, claude-tmux, codex. Nine tools,
  including the four `cron_*`.
- **pi extension** (`hermit-pi-extension.ts`) — pi, omp, prime. Six tools, and
  **no cron tools at all**.
- **dsh and kimi have neither.** The gateway injects nothing into them.

So a change to the stub covers three backends, not six. Anything that must hold
for the pi family has to be made twice, in both surfaces — which is why
`writeMemory` lives in `mcp-stub-util.cjs`, required by the stub and by the
extension, rather than being implemented in either.

`HERMIT_CHAT_ONLY=1` makes the stub drop `cron_create` / `cron_update` /
`cron_delete`: they schedule work that fires **later** as a normal turn with a
full tool surface, so leaving them on would route around the mode rather than
respect it. `cron_list` stays; reading a schedule is fine. The pi family needs
no equivalent — it never had those tools.

## Memory is the one exception, and it is a narrow one

A session that cannot record what it just worked out forgets the conversation
the moment it ends, which would make the mode useless for exactly the
thinking-out-loud it exists for. So both tool surfaces gain **one** write tool
when `HERMIT_CHAT_ONLY=1`: `memory_write`.

It is deliberately narrow, and each limit is load-bearing:

- **Only memory paths** — `memory/**`, `evolution/**`, `MEMORY.md`. Enforced by
  `resolveMemoryPath` on the RESOLVED path, so every spelling of `../` is judged
  by where it lands rather than by how it looks.
- **Markdown only.** A pure-chat session cannot run what it writes — but a later
  ordinary session in the same directory can, and "park a shell script in
  memory/ now, have it run next week" must not be reachable from a mode that
  promises nothing changes.
- **Nothing can be destroyed.** `append` and `prepend` keep the existing text;
  `create` refuses a file that already exists. There is no overwrite and no
  delete. This is the property that makes a write tool acceptable here at all.
- **Symlinks are resolved.** The string gate cannot see a symlinked `memory/`;
  `writeMemory` realpaths the deepest existing ancestor and the target.

27 tests in `mcp-stub-util.test.ts` cover it, including two symlink escapes that
assert the outside file was left untouched. If you change that gate, change them
first.

`pi` and `prime` must NAME `memory_write` in their `--tools` allowlist (theirs
covers extension tools); `omp` must NOT (its allowlist covers built-ins only and
hard-errors on anything else). Same asymmetry as `HERMIT_TOOL_NAMES`.

### prime cannot serve this mode, and the UI says so

prime has exactly one built-in tool, `ipython` — a persistent Python kernel in
which reading, writing, running commands and spawning sub-agents all happen.
There is no read-only subset to keep. A pure-chat prime session therefore holds
hermit's extension tools and nothing else: it can talk and hand you a file, but
it cannot even read one.

sway chose this over pretending the backend supports the mode (2026-09-01), so
the new-chat form warns as soon as the two are selected together rather than
letting the session start and disappoint.

### What is not verified yet

- **dsh** — the box this was built on had a broken dsh install (every
  `@deepseek-ai` package symlinked into a cleared npx cache), so
  `DSH_PERMISSION_MODE=read-only` was never run.

  Do not read it as a second line of defence: the plugin removal takes away the
  shell, the editor, sub-agents and workflows, but `dsh-tool-fs` stays composed
  so the session can still read — and its write half is stopped by that env
  value alone. It is load-bearing.

  What is known is the failure mode, and it is the good one: dsh resolves its
  profile at boot and an unrecognised value fails there **loudly**, the same
  path an invalid `api` field takes. So the first pure-chat dsh session either
  works or refuses to start; it cannot come up looking read-only while quietly
  being writable. If it refuses, find dsh's real third enum value rather than
  dropping the line — without it, `dsh-tool-fs` can write.

  One run on a machine with a working dsh settles it.
- **kimi** — tool names came from the installed binary rather than a guess, and
  the profile writes both `tools` (allowlist) and `disallowedTools` (denylist)
  so a renamed key upstream costs a tool rather than the whole mode. Still
  worth one end-to-end run.

## Where the flag travels

The gateway has no database access — it polls tRPC — so every `select` on the
way is a gate, and a missed one loses the field **silently**.

```
new-chat-pane.tsx  →  chat.createSession (zod input + create data)
                   →  ChatSession.chatOnly
chat.pollPending select  →  api.ts pollChatPending type
                         →  chat-runner.ts PendingSession
                         →  runtime.ensure({ chatOnly })
                         →  each backend's boot()
chat.getSession / listSessions / sessionDetail selects  →  the header chip
```

`listSessions` needs it too, not only `getSession`: the chat page's `session` is
a union of both rows plus a cached one, so the header can only read a field all
three carry.

## Spawn-time, not runtime

This is a property of the child process, not a permission checked per call.
Flipping it on a live session would do nothing until the child respawns, which
is why there is no toggle in the session detail sheet — only a chip in the
header stating what the session is. A conversation that wants the other mode
starts a new session.

## Adding a backend

Add its switch to `chat-only.ts` (or its runtime, if the shape doesn't fit a
list of tool names), read `session.chatOnly` in its `boot()`, decide which of
the two tool surfaces it mounts (if either — that decides whether it can record
anything), and add a row to the table above with an honest "verified" column. A backend that cannot
enforce it must say so in the new-chat form, the way prime does. Silently
accepting the tick and running with full tools is the one outcome to avoid.
