# prime — Prime Agent as a hermit backend

Status: runtime implemented 2026-08-21; the UI work in "The UI work" below is
not. Prime Agent is a HARNESS, not a backend — you get a backend by pairing it
with a credential under Settings → Backends. See
[backends-and-models-design.md](backends-and-models-design.md).

Follows [pi-runtime-design.md](pi-runtime-design.md) (the `AgentRuntime` seam),
[omp-runtime-design.md](omp-runtime-design.md) (spawning a pi-family CLI we
cannot import), [pi-modes-design.md](pi-modes-design.md) (spawn recipes) and
[pi-harness-design.md](pi-harness-design.md) (the tool schema is the tax).

Everything below marked **verified** was read out of the prime-agent source or
its docs at `0.7.4`. Everything marked **must be measured** is not yet known and
should not be asserted in a commit message until it is.

## What Prime Agent is

[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) (Prime
Intellect, MIT, first release 2026-08-05) is a **fork of pi**. Its README says
so, and the code agrees: the workspace packages are literally
`@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core` / `pi-tui`, on
their own version line (`0.7.4`, against the `0.83.0` the gateway pins), with a
`piConfig` block renaming the product to `prime-agent` and its config dir to
`~/.prime/agent`.

That inheritance is the whole reason this is cheap. **Verified identical to pi:**

| surface | status |
| --- | --- |
| RPC mode (`--mode rpc`), JSONL over stdio | same protocol, same `ready`/`response`/event framing |
| event vocabulary | `message_end` with `{text,thinking,toolCall}` parts, `tool_execution_end` with `{toolCallId,toolName,result,isError}` — byte-for-byte the shapes `translatePiEvent` already handles |
| extension API | default-export factory receiving `pi`; `pi.registerTool`, `pi.registerCommand`, `pi.registerProvider`, `pi.on('tool_call')` returning `{block, reason}` |
| extension loading | jiti, so `hermit-pi-extension.ts` stays a `.ts` file |
| skills | `SKILL.md` with `{name, description}` frontmatter |
| `--tools` semantics | allowlist covering built-in **and extension** tools — pi's meaning, not omp's inverted one |

Two things are genuinely new, and they are the reason to bother:

**RLM (recursive language model).** There is exactly **one** built-in model
tool: `ipython`. Reading files, editing them, running commands, calling skills
and spawning subagents all happen as Python inside a persistent IPython kernel
whose variables survive tool calls, compaction and kernel restart. Subagents are
a function call — `await rlm("review the auth flow", name="auth-reviewer")` —
which returns at *admission* with a handle, never the child's answer; children
reply through `agent_message.send(..., receiver_role="parent")` on a later turn.

**The continual harness.** Supplemental prompts, memories, skill descriptions
and subagent specs are durable CRUD state under
`session-artifacts/<root>/harness/harness_state.json` (plus a global
`~/.prime/agent/harness/`). The `/refine` command reviews the live trajectory
and applies small evidence-backed edits to that state mid-run, with before/after
snapshots for rollback. The base system prompt stays immutable.

Underneath both sits a **daemon**: a supervisor owning a JSONL socket, one
detached worker process per root session tree, per-session schedulers, leases
keyed by session path, generation-aware event cursors, and agent-to-agent
message routing. Closing the client detaches; the work keeps running.

## Why it earns a backend slot

hermit already runs five backends. The argument for a sixth is not "another
model" — it is two things this fleet has hand-built and prime has natively.

**One tool, not thirty-one.** [pi-harness-design.md](pi-harness-design.md)
measured the standing tax on this fleet: omp with everything on cost 22,099
tokens/turn, stock pi 4,210, `pi --tools read` 3,694. Cutting 21 tools to 4
saved ~49%; turning off skills, rules and LSP together saved ~4%. **The tool
schema is the tax.** Prime takes that to its limit with a single `ipython`
schema — but it must then spend prompt on teaching the Python surface, `rlm`,
the harness and the skill-import convention. Whether the net is cheaper than
`answer`/`scout` **must be measured**, on the same 15-file-repo task the
harness doc used, before a word of this is presented as a win.

**Long-running work is native, not bolted on.** hermit built cron, `loop`,
heartbeat prompts, session hibernation and `--resume` wake-up itself, each
against a harness that did not want them. Prime ships daemon-resident sessions,
per-session schedulers, persistent goals with token budgets, heartbeats, bounded
autonomous mode with shell quality gates, and direct agent-to-agent messaging.
Most of that hermit will *not* adopt (see non-goals) — but a backend whose
sessions survive their client, and whose subagent tree survives compaction and
kernel restart, is a different shape from everything in the fleet.

## Non-goals

- **Replacing pi, omp or claude-tmux.** Same posture as every backend before it.
- **The Claude Code subscription.** The mechanism needs no new code — prime
  vendors the same `pi-ai`, so `ANTHROPIC_OAUTH_TOKEN` still takes precedence
  and still triggers the stealth OAuth branch. It is refused anyway, and the pi
  path that had it has been removed with it: pointing three harnesses at one Max
  account is what rate limits and the request classifier exist to catch. Prime
  is an API-key harness. See the subscription section of
  [backends-and-models-design.md](backends-and-models-design.md).
- **Adopting prime's daemon as hermit's supervisor.** It supervises prime
  sessions; the gateway keeps supervising everything else.
- **Prime's scheduler.** hermit's cron is the scheduler of record. See
  "Two schedulers is a bug factory" below.
- **RLM children as first-class hermit ChatSessions.** v1 shows them read-only.

## Why a backend, not an engine under pi

omp is an *engine* inside the pi backend, chosen by the mode, because "pi or
omp" and "coding or ops" are one decision and one Settings → Pi Runtime page
configures both. Four things stop prime from fitting there, all verified:

1. **Different config dir and stores.** `~/.prime/agent/{auth.json, sessions/,
   session-artifacts/, extensions/, skills/, harness/}`. Nothing is shared with
   `~/.pi/agent`; a machine can be logged into one and not the other.
2. **Different resume flag.** pi resumes with `--session <path>`; prime has no
   such flag — it is `-r/--resume <path|id>` (verified in `cli/args.ts`). The
   spawn recipe is not shareable, which is what a mode *is*.
3. **Mode tool lists are meaningless here.** Every hermit mode's `tools` array
   is written in pi's vocabulary (`read`, `bash`, `edit`, `write`, `grep`).
   Prime's built-in set is `["ipython"]`. `scout`'s `read,grep,find,ls` would
   allowlist four tools that do not exist and drop the only one that does.
4. **It owns its sessions.** A pi child is a process the gateway holds. A prime
   session is leased by a daemon worker; a second client opening the same
   session file gets `session_already_active` rather than a silent double-writer.

So: `RuntimeKind` gains `'prime-rpc'`, alongside `codex-exec` and `dsh-exec`,
and `resolveRuntime` nulls `runtimeMode` for it exactly as it does for those two.

## The seam

`runtime/prime-rpc.ts` implementing the existing `AgentRuntime` interface. No
change to `types.ts` beyond widening `RuntimeKind`; no change to `chat-runner`
beyond `runtimeFor()` returning the new instance.

| `AgentRuntime` | prime RPC |
| --- | --- |
| `ensure` | spawn `prime-agent --mode rpc [--resume <path>]`, await `ready`, `get_state` for `sessionId` |
| `submit(text, images)` | `{type:"prompt", message, images}`; if `isStreaming`, add `streamingBehavior:"steer"` |
| `isWorking` | `get_state` → `isStreaming` |
| `interrupt` | `{type:"abort"}` |
| `compact` | `{type:"compact", customInstructions}` |
| `usage` | `get_session_stats` → `contextUsage.tokens` / `cost` / `tokens.total` |
| `stop('hibernate')` | close stdin; the worker drains and writes the session file |
| `stop('kill')` | SIGKILL the child (the daemon reaps its worker) |

`get_session_stats` maps onto `RuntimeUsage` without violence, and this is the
one place prime is *better* than the pi path by construction: `contextUsage` is
"the actual current context-window estimate used for compaction and footer
display" — exactly the "how full is the window right now" that `contextTokens`
is documented to mean, rather than something we reconstruct from the last model
call. Child usage is folded into the parent turn and persisted as a
`child_usage_attributed` entry, so `cost` already includes subagents and the
cost collector stays honest without extra work.

### What is reused, and one bug to not carry across

**`pi-events.ts` (`translatePiEvent`) unchanged.** The event union in prime's
`rpc-types.ts` is the same one omp was verified against. Reuse it; do not fork.

**`pi-sessions.ts`** pointer store, same shape (`<AGENTS_ROOT>/.hermit/` →
machine-local, because a session-file path synced to another host names a file
that is not there), with `--resume` in place of `--session` and the same
`flushed` flag distinguishing "a conversation was lost" from "there was never
one".

**`omp-transport.ts` generalized** — spawn a CLI, JSONL over stdio, death
observed off the child's `exit` event rather than sniffed out of an error
string. But **not copied as-is**, because it carries a latent framing bug:

> `omp-transport.ts` reads the child with `readline.createInterface(...)`.
> Prime's `modes/rpc/jsonl.ts` carries the comment *"This intentionally does not
> use Node readline. Readline splits on additional Unicode separators that are
> valid inside JSON strings and therefore does not implement strict JSONL
> framing."* pi's docs say the same, which is why `pi-rpc.ts` uses pi's own
> compliant `RpcClient` and never hit it. A `U+2028` or `U+2029` inside any
> string in a frame — scraped web text, a JS bundle echoed into a tool result —
> splits one record into two unparseable ones, and `onLine` silently drops both.

The shared transport should split on `\n` only, strip a trailing `\r`, and cap
line length. Fixing it fixes omp too; that is a small separate commit, landed
first, with a test that feeds a frame containing `U+2028`.

**`hermit-pi-extension.ts` unchanged**, and this is the largest single saving:
the five hermit tools (`ask`, `attach_image`, `attach_file`,
`set_session_title`, `log_status`) register through the same `pi.registerTool`,
against the same dashboard endpoints, with session identity arriving through
`HERMIT_SESSION_ID` / `HERMIT_KEY` / `HERMIT_DASHBOARD_URL` as today. One
adjustment: because `--tools` is pi's allowlist and not omp's restriction, the
`HERMIT_TOOL_NAMES` union applies — if a recipe ever names tools, hermit's five
must be in the list or they vanish.

## Spawn recipe

```
prime-agent --mode rpc
  --provider <machine provider>  --model <resolved>
  --extension <hermit-pi-extension.ts>
  [--resume <session file>]
  [--append-system-prompt <hermit identity>]
  --offline                      # no update check on every session boot
```

`env`: `PRIME_AGENT_CODING_AGENT_DIR` (per-agent config dir, if we want agents
isolated from each other's harness state — **decide this before the pilot**),
`PRIME_AGENT_SESSION_DIR`, `PI_SKIP_VERSION_CHECK=1`, plus the three `HERMIT_*`
vars, plus the credential for whichever catalog entry this backend is pointed
at: `ANTHROPIC_OAUTH_TOKEN` for the Claude subscription entry, or the api-key
entry's provider registration from `machineProviderEnv()`. That is the existing
`pi-credentials.ts` split, reused as-is.

One flag deliberately absent: `--tools`. There is one built-in tool and we want
it; naming an allowlist here can only subtract.

## Data model

**No new columns.** Prime is a harness, so it appears in a `BackendInstance`
under `Machine.backendsConfig`; `Agent.runtime` / `ChatSession.runtime` hold
that instance's id. `runtimeMode` resolves to null — prime has exactly one
built-in tool, so a mode's tool allowlist would name four that do not exist and
drop the only one that does. `claudeSessionId` carries prime's session id, as it
already carries pi's and codex's.

`lib/runtime-labels.ts` gains the backend: label `Prime Agent`, short label
`Prime`, detail `Prime Agent · <provider> · <model>`, and `'prime-rpc'` joins
`PANELESS_RUNTIMES` — the chat header's terminal button must not offer a
`tmux attach` to a pane that does not exist (the bug codex shipped with).

`lib/backend-availability.ts` needs nothing: config stores the *disabled* set,
so a new backend appears on every machine by default. **That is wrong here** —
prime needs an install (below) that most machines will not have. Seed
`disabled: ['prime-rpc']` for existing machines in the same migration that adds
the option, and let the pilot machine turn it on.

## Install, and the Python the fleet does not have yet

Prime installs as a **global npm package** (`curl … install.sh | sh` →
Node ≥ 20.6; the fleet is on 26). That part is ordinary.

The kernel is not. The RLM runtime needs Python ≥ 3.11 with `ipykernel`, `mcp`,
`nest-asyncio` and `tyro`, bootstrapped by **uv** into
`~/.prime/agent/kernel-venv` on first run; `PRIME_AGENT_KERNEL_PYTHON` points at
an existing interpreter instead. This Mac has uv at `~/.local/bin/uv` and
python3 from Homebrew; the macminis and spark **must be checked, not assumed**.

Posture copied from omp: **not a gateway dependency.** `resolvePrimeCli()` looks
for the global install, falls back to `HERMIT_PRIME_CLI`, and a machine without
it fails the spawn with instructions rather than silently. A gateway preflight
should additionally report a missing kernel-venv as its own message — "prime is
installed but its Python kernel is not" is a different fix from "prime is not
installed", and the first turn of a session is a bad place to learn either.

## Memory — the part that can hurt this fleet

[resource-governance-design.md](resource-governance-design.md) exists because
macmini1 accumulated 43 idle ~500MB `claude` processes over 11 days and went
into a gray failure at 96% swap. Prime's per-session footprint is **a detached
worker process plus an IPython kernel**, and an RLM child can carry its own
kernel. That is more processes per session than any backend the fleet runs.

It also lands in an existing blind spot. `collect/session-snapshot.ts` derives
`rssMb` from `subtreeRssMb(tmuxPanePid(...))`; runtime-backed sessions take the
earlier branch and already report `rssMb: null`. So pi, omp, codex and dsh
sessions are invisible to the host-health panel today — prime just makes that
invisibility expensive, and its workers are detached from the gateway's process
tree, so even fixing the runtime branch by walking the gateway's children would
miss them. Mapping session → worker pid needs the daemon's worker descriptors
under the agent dir.

**Decision: prime is Mac-and-spark only until per-session RSS numbers exist.**
No macmini rollout on a promise.

## The UI work

The backend is a week of plumbing that mostly already exists. The interesting
design is what the dashboard shows, and there are three pieces.

### 1. The `ipython` cell — table stakes, not a nice-to-have

Every tool call prime makes is `ipython`, and its input is `{code}`.
`ToolChip` renders `→ ipython {code: "from pathlib import Path\nconfig…"}` with
a 32-character truncation and a JSON blob behind a disclosure triangle. A whole
prime session would read as an undifferentiated column of the word "ipython".

`tool-chips.tsx` gains a branch on `name === 'ipython'` that renders a notebook
cell: the Python syntax-highlighted (not JSON-stringified), the result split
into stdout / return value / traceback, `%%bash` cells labelled as shell. Errors
matter most — a Python traceback rendered as an escaped JSON string is unreadable
on a phone, which is where most of this fleet gets read.

This is the single highest-value UI change and it should land **with** the
backend, not after. Without it the pilot cannot be evaluated by looking at it.

### 2. The subagent tree — read-only, off disk

`rlm(...)` runs *inside* a Python cell, so from RPC a fan-out of five children
looks like one tool call. Two ways to see them:

- **Tail the child transcripts.** They are on disk at
  `~/.prime/agent/session-artifacts/<root>/sub-xxxxxxxx/<child-session-id>.jsonl`,
  and hermit already tails JSONL for the claude path. No upstream change.
- **`observe <activeSessionId>`.** RPC has the command (verified) and wraps the
  target's events as `observed_session_event`. But no RPC command *lists*
  children — `rlm.list_subagents()` is a kernel-side skill — so hermit would
  have to learn the ids from the extension, which can read the parent registry
  in-process and POST them like every other hermit tool.

**v1: option one.** A "Subagents" panel on the session, listing name, model,
running/completed, last message, expandable into the child's transcript. Option
two is the upgrade path when someone wants to watch a child live.

Note for whoever builds it: default `RLM_MAX_DEPTH` is 1, so the tree is one
level deep unless configured otherwise. Do not build a recursive renderer first.

### 3. The harness panel — the reason to want this backend in hermit

`harness_state.json` is the agent's own operating state: notes it wrote to
itself, memories, skill descriptions, subagent specs, and a refinement history
with before/after snapshots. hermit already has editors for global memory and
skills; this is the same kind of object, except the agent maintains it.

Render it read-only, per session, with the refinement history as a timeline.
Add one button — **Refine** — wired to the `refine` RPC command
(`{type:"refine", instructions?, rollbackId?, global?}` → `RefinementResult`,
verified), and let a history entry roll itself back by passing its `rollbackId`.

That is a small amount of code for the thing no other backend in the fleet can
show: an agent that visibly edits how it works, with an undo button.

### Smaller surfaces

- **Goal chip.** `get_state()` already returns `goal: GoalState`. One row under
  the context bar; no new plumbing.
- **Images.** Prime's `prompt` accepts `images` natively, so this backend does
  **not** need the OpenRouter fallback in `vision.ts` that omp needs.
- **Session name.** `set_session_name` exists, but hermit's `set_session_title`
  tool already POSTs the title to the dashboard. Leave it alone.

## Permissions, honestly

pi's gate is the extension's `tool_call` handler returning `{block, reason}`,
and prime has it unchanged. But with exactly one tool whose input is arbitrary
Python, a per-tool allowlist means nothing and the gate degrades to "read this
Python and decide" — which no matcher can do and no human will do per cell.

So: **prime sessions run unrestricted**, the same posture pi sessions and cron
sessions already have, and that raises rather than lowers the bar for which
agents get to run on it. Prime's own docs are blunt about this ("not a security
sandbox"), and the honest mitigation is the same one they name: trusted repos,
or an external sandbox.

One thing prime adds that pi did not: `tool_result` middleware, which can
rewrite or redact a result before it reaches the model. That is a better place
than `tool_call` for the one rule worth enforcing mechanically — keeping
credentials out of what gets sent upstream.

## Two schedulers is a bug factory

Prime's RPC exposes `add_schedule`, `set_heartbeat`, `list_schedules`,
`manage_heartbeat`. It is tempting and it should be left alone in v1, for a
reason that is structural rather than tidiness: **adding a schedule or heartbeat
promotes an invocation-local RPC session into a resident daemon session** so the
work outlives stdin. The gateway would then be holding a child it no longer
owns the lifetime of, `stop('kill')` would stop a client rather than the work,
and hermit's cron and prime's scheduler would both be entitled to prompt the
same session.

hermit's cron stays the scheduler of record. A cron fire is a submitted turn on
a session, exactly as it is for pi. If prime's resident sessions later turn out
to be *better* than hibernate-and-`--resume`, that is its own design, with the
ownership question answered first.

`--autonomous` and its budget flags are the same story from the other side: they
are spawn-time host policy that overlaps the `loop` skill. Note them, do not
wire them.

## Cron

`cron-runner.ts` goes through `AgentRuntime` for the runtime backends already,
so prime inherits it. But a cron fire on prime pays for a daemon worker **and**
an IPython kernel boot, and `--mode json -p` one-shot pays it too. Whether that
is affordable per fire **must be measured** (`scripts/boot-bench.mjs` and
`bench-daemon-startup.mjs` ship in the prime repo and measure exactly this).
Until then, cron agents stay on what they run on now.

The `--dangerously-skip-permissions` equivalent is a non-issue: with no gate
installed there is nothing to block on, which preserves the fix for the
2026-06-26 fleet-wide cron hang.

## Rollout

1. Land the LF-only framing fix in the shared transport, with a `U+2028` test.
   It fixes omp today and stops prime inheriting the bug.
2. Install prime on this Mac only. Measure, before writing any runtime code:
   standing tax per turn against the `pi-harness` 15-file task, cold and warm
   boot latency, and RSS of worker + kernel at idle and under a 3-child fan-out.
3. `runtime/prime-rpc.ts` + `runtimeFor` dispatch + labels, backend seeded
   disabled everywhere.
4. The `ipython` cell renderer. Land with step 3, not after.
5. One **new** pilot agent on an API-key provider — not an existing fleet
   member, and not one with cron attached.
6. Subagent panel and harness panel, in that order.
7. macminis only if step 2's RSS numbers survive contact with 16GB.

Gateway changes need a per-machine restart, so Mac first, then the minis, with
the usual lag.

## Risks

- **Two pi lineages in one gateway.** The pinned `@earendil-works/pi-coding-agent@0.83.0`
  and prime's vendored `0.7.4` share package names. `prime-rpc.ts` must spawn a
  *binary* and speak the wire protocol — the same rule omp follows for a
  different reason — and must never `import` from prime's tree. If it ever
  becomes a dependency, npm will resolve one of the two and the loser breaks
  silently.
- **A fork tracking nothing.** omp's docs put its last upstream sync at
  2026-03-22 and it is diverging. Prime is two weeks old and its own product.
  Expect the shared translator to fork eventually; `pi-events.test.ts` fed
  recorded prime events is what will tell us when.
- **Process count.** Covered above. The fleet has been here before.
- **Model quality dependence.** The RLM design asks the model to *write correct
  Python* for every file read and edit. A weak model that could still limp
  through `read`/`edit` tool schemas will fail differently and worse here. Pilot
  on a strong model; do not evaluate the harness on a cheap one and conclude
  anything.

## Testing

- Existing gateway tests pass unchanged — the seam is additive.
- `runtime-resolve.test.ts`: `prime-rpc` resolves with `runtimeMode: null`, and
  a session's own choice is never re-pointed by `backendsConfig`.
- Transport: a frame containing `U+2028` arrives as **one** event.
- `pi-events.test.ts` extended with recorded *prime* events, asserting the
  Anthropic-native block shapes the dashboard renders — in particular that an
  `ipython` call becomes a `tool_use` the new renderer recognises.
- End-to-end, driving the runtime through `AgentRuntime` as chat-runner does:
  `ensure` returns prime's session id; `isWorking` false; `submit` accepted;
  a tool-using turn produces `assistant[thinking+tool_use] → user[tool_result]
  → assistant[text]`; `usage` reports real context and cost; `stop('hibernate')`
  exits 0 and leaves a resumable session file; a fresh `ensure` with `--resume`
  reports the same `sessionId` and message count.
- A fan-out test: three `rlm()` children, then assert the parent's
  `get_session_stats` cost includes them and the child JSONLs exist where the
  subagent panel will look for them.

## Open questions

| question | why it matters |
| --- | --- |
| Per-agent `PRIME_AGENT_CODING_AGENT_DIR`, or one shared `~/.prime/agent`? | Shared means agents read each other's global harness state and skills — possibly the point, possibly a leak. Decide before the pilot writes state. |
| Is the standing tax actually lower than `scout`/`answer`? | The headline reason to want this. Unmeasured. |
| Does a kernel boot per cron fire cost more than the fire is worth? | Decides whether prime can ever host recurring work. |
| Can the daemon's worker descriptors give the collector a pid? | Decides whether prime sessions are visible to host-health at all. |
| `session_already_active` on a resume race — error or recoverable? | The pi path shipped a concurrent-`ensure()` bug that rewrote a session's first message in place. Prime's lease turns that class of bug into an error, which is better — as long as `ensure` treats it as "wait and re-attach", not "fail the turn". |
