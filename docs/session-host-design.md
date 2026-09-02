# The session host — surviving a gateway restart

Status: implemented behind `HERMIT_SESSION_HOST=1`, 2026-09-02.
Companion to `claude-sdk-runtime-design.md`, whose "the one thing a pane does
better" this removes.

## The fact everything else follows from

Whoever holds a claude child's stdin owns its life. The CLI reads stream-json
from stdin and exits on EOF — that is how `shutdownClaudeSdk()` ends a session
deliberately — and the write end of that pipe is a file descriptor in the
gateway process. The official SDK spawns with `stdio: ['pipe','pipe','pipe']`
and exposes neither `detached` nor the stdio options, so no flag changes this.

`pm2 restart hermit-ui-gateway` therefore ended every claude-sdk session on the
box, which is why gateway code changes were batched into one restart window a
day: 18 live sessions and 4.8 GB of children, all of it gone to ship one commit.

The only shape that works is a second process that does not restart when the
gateway does.

## What it is

`src/session-host/` — one daemon per machine, its own pm2 app, holding every
claude child. The gateway reaches it by telling the Agent SDK that `claude`
lives at `session-host/attach.mjs`; that shim connects to the host's unix socket
and pipes stdio through. What dies with a gateway restart is the shim.

```
gateway ──(SDK spawns)──► attach.mjs ──(unix socket)──► session host ──► claude
   ▲                          ▲                              │
   └── restarts daily ────────┘ dies with it                 └── does not
```

The SDK's transport, argv, control protocol and version handling are all
untouched: the shim forwards the SDK's own argv to the host, so there is no
second copy of it anywhere to drift.

## Why the host must stay dumb

It does not parse a frame, does not know what a turn is, does not talk to the
dashboard and has no database access. It holds children and moves bytes. Every
interpretation — event translation, activity, dedupe, persistence — stays in the
gateway.

That is the design, not an implementation detail. The gateway is 48k lines that
change every day; the host must almost never restart, because restarting it ends
every session on the machine. The only way to keep those two facts compatible is
to make the surface between them so narrow that a gateway feature cannot need a
host change. A byte stream plus one attach message is as narrow as it gets.

**If you are about to add a feature to the host, check first whether it belongs
on the other side of the socket.**

## What was measured before any of it was written

A throwaway prototype against a real Claude Code
(`asst/projects/gateway-restart-survival/proto`), then the same properties as
integration tests (`src/runtime/session-host.itest.ts`):

| | result |
| --- | --- |
| A second client attaching to a running child | Same session id, same model, warm context, **no `--resume`** |
| Adopt + answer | 2.1s, against ~3.2s for a transcript resume — and no prompt-cache rewrite |
| A client killed mid-turn | The turn keeps running; the next client sees its conclusion |
| `[1m]` model variant | Preserved. A `--resume` drops it (measured: `claude-opus-5[1m]` → `claude-opus-5`), so every wake re-pays the whole prompt cache write; adopting a live child does not |
| A PreToolUse hook during the gap | The CLI parks at the next tool call and **resumes on reattach**, redelivering the pending callbacks |

That last one is better than the design assumed. A host-side "answer the hook
after N seconds" is therefore a fuse for "the gateway never came back", not a
requirement. It also means tool execution *pauses* while no gateway is attached,
which is arguably the right thing.

One constraint it imposes: **hook callbacks are redelivered, so a hook must be
idempotent.** Ours only adds `run_in_background` to a Bash call that asked for
neither that nor a timeout, which is.

## What the gateway had to learn

- **`outlivesGateway()` / `detach()`** on `AgentRuntime`. The shutdown drain
  asks the first and, when the answer is yes, does the second instead of waiting
  for the turn, cutting it and closing the child. A backend that claims to
  survive but cannot detach is drained the old way — half a capability is not
  one.
- **`stop()` goes through the host.** Tearing down the SDK handle only kills the
  shim, which is the whole point of the shim and exactly wrong when the caller
  means "this session is over". Hibernate, restart and delete all mean that.
- **Reattach on startup** (`reattachHostSessions`). Without it the host makes
  things worse for the case it was built for: a long autonomous turn survives
  the restart, but the new gateway is not listening, so the conversation on
  screen stays frozen until somebody sends a message. Nothing is spawned — the
  shim adopts the child, and the transcript tail replays what landed while
  nobody was attached.

## The gap the transcript covers

The host keeps no replay log. Frames produced while no client is attached are
not re-sent; the runtime's existing `tail -F` of the session JSONL is what fills
the gap, exactly as it already did for a gateway that was down. The two sources
carry the same records under the same uuids and one `seen` set dedupes them.

What the tail does not carry — streaming partials, control responses, the
`result` frame — is state the new handle starts clean on anyway.

## Operating it

Two ecosystem files, two lifecycles, and that separation is load-bearing:

```bash
# a gateway change (safe, sessions survive it)
pm2 startOrRestart apps/gateway/ecosystem.config.cjs && pm2 save

# a host change (ends every live session on the machine — treat it the way a
# gateway restart used to be treated: ask first, batch it, expect to pay)
pm2 startOrRestart apps/gateway/ecosystem-session-host.config.cjs && pm2 save
```

`pm2 startOrRestart <file>`, not `pm2 restart <name>`: pm2 keeps `treekill` and
`kill_timeout` in its own saved copy of an app and does not re-read the file on
a restart-by-name. The gateway checks its own pm2 settings at startup and prints
this command when they are wrong (`src/pm2-config-check.ts`), because that
failure is otherwise completely silent.

Turn it on per machine with `HERMIT_SESSION_HOST=1` in `apps/gateway/.env`. Off,
everything behaves exactly as before.

## Bounds

- A child nobody has attached to for 30 minutes is killed by the host. It is the
  one thing this process makes leakable — 300 MB each, and without the gateway
  nothing else on the machine knows they exist. A restart reattaches in seconds
  and the Layer 1 resume window is 15 minutes, so half an hour means "the
  gateway is not coming back".
- The host ends its children when it shuts down cleanly. Nothing can adopt a
  running child's stdio — the pipes are file descriptors in the host, which is
  the same fact that stopped the gateway holding them. Children left behind
  would be unreachable, and the gateway's orphan reaper would shoot them
  seconds later anyway.
- A host that is SIGKILLed does orphan its children (ppid 1). That is what the
  claude signature in `orphan-child-reaper.ts` is for.

## Not done

- **Host generations.** Upgrading the host still ends every session. The
  intended shape is a versioned socket path with the old host draining while a
  new one takes new sessions; it is not built, because the host changes rarely
  enough that the complexity has not earned its place yet.
- **Other backends.** codex, kimi and dsh spawn one short-lived child per turn
  and resume from disk, so a restart costs them the turn in flight, not the
  conversation. Routing them through the host would work — it is deliberately
  backend-agnostic — but the payoff is much smaller.
