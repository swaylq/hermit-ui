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

| backend | how | verified |
|---|---|---|
| claude-sdk | SDK `tools: [...]` — narrows the built-in set | ✅ read the `init` event's tool list back |
| claude-tmux | `--tools Read,Grep,…` | ✅ same, plus coexistence with `--dangerously-skip-permissions` |
| codex | `sandboxMode: 'read-only'` — an **OS-level** sandbox (seatbelt / landlock), the hardest of the eight | ✅ flag exists in the SDK's own types + CLI help |
| pi | `--tools read,grep,find,ls`, unioned with hermit's extension tools | ✅ pi's own docs give this exact recipe; the shipped `scout` mode already uses it |
| omp | `--tools <read-only subset of its 31 built-ins>`, **not** unioned | ✅ union would hard-error the spawn; documented in `pi-modes.ts` |
| dsh | write/exec plugins removed from the `--patch` composition, **plus** `DSH_PERMISSION_MODE=read-only` | ⚠️ plugin removal uses a mechanism this file already relies on; the `read-only` enum value is **unverified** — see below |
| kimi | an agent profile in `KIMI_CODE_HOME`, bound with `--agent-file` on the first turn and restored automatically on resume | ⚠️ tool names read out of the installed CLI; the profile itself is unverified end to end |
| prime | `--tools <hermit extension tools only>` — which removes its single built-in | ✅ trivially, and uselessly — see below |

### The one place a rule is enforced once for everyone

`mcp-stub.cjs` drops `cron_create` / `cron_update` / `cron_delete` when
`HERMIT_CHAT_ONLY=1`. They schedule work that fires **later** as a normal turn
with a full tool surface, so leaving them on would route around the mode rather
than respect it. `cron_list` stays; reading a schedule is fine.

This is the only rule that covers claude-sdk, claude-tmux, codex, pi, omp and
prime in one place, because it is the only tool surface the gateway itself
serves. Everything else is per-backend by necessity.

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

- **dsh** — the box this was built on had a broken dsh install, so
  `DSH_PERMISSION_MODE=read-only` was never run. It is applied as belt; the
  braces are the plugin removal, whose mechanism (`disabled: true` in the
  generated patch) this file already uses on every turn. If the enum value is
  wrong, dsh ignores it and the plugin removal still holds. Worth one run on a
  machine with dsh installed.
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
list of tool names), read `session.chatOnly` in its `boot()`, and add a row to
the table above — including an honest "verified" column. A backend that cannot
enforce it must say so in the new-chat form, the way prime does. Silently
accepting the tick and running with full tools is the one outcome to avoid.
