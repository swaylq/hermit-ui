# omp — a third agent backend

Follows [pi-runtime-design.md](pi-runtime-design.md) (pi as a second backend)
and [pi-modes-design.md](pi-modes-design.md) (per-session spawn recipes).

## What omp is

[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`, MIT, 22k★) is a fork of
pi by Can Bölük. Where pi keeps four tools and expects you to add the rest, omp
ships 31 built-ins — `ast_edit`, `lsp`, `debug`, `browser`, `computer`,
`github`, `memory`/`recall`/`learn`, `security_scan` — plus MCP, which pi
deliberately omits.

It is offered **alongside** pi, not instead of it. pi is small and predictable;
omp is capable and moves fast (17.2.9 against pi's 0.83.0, and its own docs put
the last upstream sync at 2026-03-22, so it is diverging rather than tracking).
Which is right depends on the work, so the choice is per session like every
other backend choice.

## Why we do not use omp's own RpcClient

omp ships an `RpcClient` whose option and method surface match the one
`pi-rpc.ts` already drives — `{cliPath, cwd, env, provider, model, args}` and
`start/stop/onEvent/prompt/steer/abort/getState/compact/getSessionStats`, every
one of them a name-for-name match.

It still cannot be imported. omp's library code does `import ... from "bun"`
(through `@oh-my-pi/pi-utils`), and Node cannot resolve that:

```
Error: Cannot find package 'bun' imported from
  @oh-my-pi/pi-utils/src/frontmatter.ts
```

Moving the gateway onto Bun to gain one library would put ~24 live claude
sessions on a new runtime for no benefit of their own. So `omp-transport.ts`
speaks the wire protocol instead — NDJSON over stdio, fully documented, and we
need eight of its commands. It gets one thing better than the pi path in the
bargain: process death arrives on the child's `exit` event rather than being
sniffed out of an error message (`isDeadClientError` in pi-rpc.ts).

## What is shared, and what is not

**Shared unchanged:** `translatePiEvent`. omp emits the same event vocabulary as
pi — `message_end` with `{text, thinking, toolCall{id,name,arguments}}` parts,
`tool_execution_end` with `{toolCallId, toolName, result, isError}` — verified
against a live child rather than assumed, so the translator is reused rather
than forked. Also `singleFlight`, the mode loader, and the hermit extension.

**Not shared:** pi-rpc's session-resume pointer store and provider-mismatch
detection. Those are refinements earned by pi being in production; omp starts
without them and will grow the ones it turns out to need. A restart therefore
loses an omp session's context today, and that is a known gap, not an oversight.

## Three places the two backends genuinely differ

**1. `--tools` means the opposite thing.** Measured on both:

| | pi | omp |
|---|---|---|
| default active | `read, bash, edit, write` | all 31 |
| `--tools` covers | built-ins **and extension tools** | built-ins **only** |
| naming an extension tool | allowlists it | **hard-errors the spawn** |
| extension tools when `--tools` is set | dropped unless named | always available |

So pi's list reads "also switch these on" and omp's reads "restrict to these",
and pi's `HERMIT_TOOL_NAMES` union — which exists so a mode author cannot
accidentally drop `ask`/`attach_image` — would fail an omp spawn outright. Modes
therefore carry a separate `ompTools` field rather than a translation. Omitted
means omp keeps its full surface.

**2. Skills.** pi's `--skill <path>` *adds* on top of discovery; omp's
`--skills <glob>` *filters* discovery down. Passing a mode's skill list to omp
would hide every other skill the agent has, so omp gets no skill flag at all —
it already discovers `.claude/skills/` natively (verified: it listed this
agent's full set, including `japan-dev-ops`).

**3. Provider configuration.** pi has no way to name a base URL, which is why
hermit registers one from an extension with `apiKey: "$HERMIT_PI_API_KEY"` —
pi expands that reference. omp declares providers in
`~/.omp/agent/models.yml` and passes the string through **literally**, so the
endpoint receives `"$HERMIT_PI_API_KEY"` as the credential and 401s. The
extension therefore skips its provider registration when
`HERMIT_RUNTIME=omp-rpc`, and the gateway generates `models.yml` from
`Machine.piConfig` instead — one source of truth, the dashboard's Pi Runtime
page, rather than two that drift. A `models.yml` without the generated marker
was written by a human and is left alone.

## Installation

omp is **not** a gateway dependency. It is 36MB and requires Bun ≥ 1.3.14;
pulling that into every machine's install for a backend most will not use is not
a trade worth making. `resolveOmpCli()` looks for the global Bun install and
falls back to `HERMIT_OMP_CLI`, and a machine without it fails the spawn with
instructions rather than silently.

```sh
bun install -g @oh-my-pi/pi-coding-agent
```

## Testing

`pi-modes.test.ts` covers the omp argument semantics — no hermit union, pi's
tool list ignored, no skill flags, extensions and prompt still passed.
`runtime-resolve.test.ts` covers omp as a mode backend and the
pi↔omp non-inheritance rule.

End-to-end, driving `OmpRpcRuntime` through the `AgentRuntime` interface exactly
as chat-runner does:

- `ensure` returns omp's session id; `isWorking` false; `submit` accepted.
- Events translate: `assistant[thinking+tool_use]` → `user[tool_result]` →
  `assistant[thinking+text]`, the reply correct.
- `usage` reports real numbers (contextTokens 20364, cost \$0.19), so the
  context bar and cost collectors work.
- `stop('hibernate')` closes stdin and the child exits 0.
- The ops mode runs on omp: its extension loads and `ssh_run`/`ssh_hosts` work.
- With `models.yml` deleted, the next boot regenerated it and the session worked.

## Known gaps

- No session resume: a gateway restart starts an omp session fresh.
- Images are not passed to `submit` yet. omp's `inspect_image` sends the image
  to the *current* model, and hyqubit drops image blocks — verified — so the
  OpenRouter vision fallback in `vision.ts` remains the path that works.
- Bun is now a hot-path dependency for this backend, and it is a strict one:
  omp 17.2.9 refused to start on Bun 1.3.13 and required 1.3.14.
