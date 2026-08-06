# Running the pi runtime on Claude Code

Status: design, 2026-08-06. Companion to `pi-runtime-design.md`.

## The ask

"Run the pi 底座 with Claude Code." The motivation is not mysterious: the fleet
already pays for Claude Max, pi agents currently need a paid provider key
(OpenRouter, DashScope, the hyqubit litellm endpoint), and pi's plumbing is
better than the tmux path's — typed events instead of scraped ANSI, per-session
model selection, no `send-keys` uuid drift. Claude-quality models on pi's
plumbing, at no marginal cost, is a genuinely attractive combination.

This document is mostly about why that specific combination is the one thing you
cannot have, and what the two achievable shapes of the same goal cost.

## What pi needs from a model

pi is an agent. It owns the loop: it sends the conversation *plus its own tool
definitions*, and expects the model to answer with `tool_use` blocks that **pi**
then executes — the hermit extension's `ask`, `attach_file`, `describe_image`,
plus pi's own `bash`/`read`/`edit`/`write`, plus whatever a skill adds.

So what pi needs from the other side is a **model endpoint**, not an agent:

- `POST /v1/messages` (or an OpenAI-compatible equivalent) — pi registers
  providers as `{baseUrl, api: 'anthropic-messages' | 'openai', apiKey}`
- faithful `tool_use` round-tripping, with pi's tool schemas, not someone else's
- streaming, multi-turn, a system prompt it controls, and usage numbers

That contract is already implemented and shipping: Settings → Pi Runtime
registers exactly such an endpoint per machine (`registerMachineProvider` in
`runtime/hermit-pi-extension.ts`). Anything that satisfies the contract works
today with no new code.

## What Claude Code exposes

Three surfaces, and the billing bucket is a property of the surface, not of the
model:

| Surface | Shape | Bucket |
| --- | --- | --- |
| Interactive `claude` in a TTY | An agent, driven by keystrokes | **Interactive** (claude.ai / terminal / IDE) |
| `claude --print -p`, Claude Agent SDK, GH Actions | An agent, driven by an API | **Agent SDK**, at full API rates against a much smaller cap |
| `api.anthropic.com` with an API key | A model | Metered API billing |

The bucket split is the load-bearing constraint, and it is a recorded finding
of this fleet, not a guess: `evolution/lessons.md` → L1, 2026-06-15. The v1
gateway routed every chat turn through `claude -p` and would have burned the
Max-20x SDK cap; the fix was to drive interactive `claude` in a tmux pane
instead. That is why `chat-runner.ts`'s tmux path is load-bearing rather than
legacy, and why `pi-runtime-design.md` says so up front.

## Why "pi on Claude Code" doesn't compose

Two independent blockers, and the second survives even if you don't care about
the first.

**Billing.** Every programmatic surface of Claude Code — `-p` and the Agent SDK
— bills against the Agent SDK bucket at full API rates. A shim that fronts
Claude Code as `/v1/messages` for pi is programmatic by definition. So the
subscription saving that motivates the whole exercise does not exist: you would
pay API rates *and* accept a smaller cap than the API's own limits.

At which point the shim is strictly worse than the thing it replaces. **If you
are paying API rates anyway, point pi at the API.** That is one settings-page
edit, not a new component.

**Architecture — the blocker that remains even at zero cost.** Claude Code is an
agent, and an agent is not a completions endpoint. Fronting it as one means:

- **Tool definitions have nowhere to go.** pi sends its tools expecting them
  back as `tool_use`. Claude Code's tools come from its own config at spawn, it
  executes them itself, and it returns prose. There is no supported way to
  inject pi's tool schemas per request and get unexecuted tool calls back out.
  A shim would have to translate pi's tools into MCP servers registered at spawn
  — and `claude mcp <anything>` mid-session destroys a live session's MCP
  handles (L2, 2026-04-23, two agents dark for hours).
- **Two agent loops nest.** pi plans, calls "the model", and Claude Code plans
  again inside that call — its own context management, its own compaction, its
  own subagents. Token accounting, interrupts, and steering all break across the
  seam, and neither loop's `isWorking` means what the other thinks.
- **No Interactive-bucket surface serves tokens.** The bucket is a property of
  running a real session, and a session is a conversation, not a completions
  endpoint. There *is* a structured way to talk to one — see Shape C below,
  which is how the previous generation of this fleet did it — but it delivers
  *turns to an agent*, not `tool_use` blocks to a caller that owns the loop. It
  does not rescue this shape; it replaces the need for it.

There is a fourth path people reach for: use Claude Code's own OAuth credential
directly against `api.anthropic.com`. Don't. It is outside the supported
surface, it breaks whenever the client's auth changes, and it is the kind of
subscription-credential reuse that puts the account at risk — a bad trade for a
fleet that depends on that account. (Note the two credentials are already
distinct: an `ant auth login` profile and Claude Code's own `/login` are
separate things, and Anthropic's own docs tell you to keep one, not both.)

## The two achievable shapes

The literal ask doesn't compose, but the goal behind it splits cleanly in two —
and they differ in *which loop survives*.

### Shape A — pi keeps its loop; Claude just serves tokens

Point the machine's pi provider at an endpoint that serves Claude models over
the Messages API: the API directly, or the hyqubit/litellm endpoint the fleet
already uses.

- **Cost:** metered API rates. No subscription saving. No smaller cap.
- **Work:** none. Settings → Pi Runtime already does this — provider id, base
  url, `anthropic-messages`, model list, key name from the secrets store.
- **Gets you:** Claude models with pi's typed events, per-session model
  selection, and no tmux — the plumbing win, paid for in tokens.

This is the answer to "I want a pi agent that thinks like Claude", available
this afternoon. Its only real question is whether the per-token cost is
acceptable for the agents in question, which is a spend question, not an
engineering one.

### Shape B — Claude Code keeps its loop; hermit gets pi-like plumbing

If what you actually want is *pi's plumbing for Claude Code agents* — typed
events, no pane scraping, no send-keys — then don't put Claude behind pi. Put
Claude Code behind the runtime interface **as a third runtime**, next to
`claude-tmux` and `pi-rpc`:

```ts
runtimeFor('agent-sdk') // AgentRuntime, implemented over @anthropic-ai/claude-agent-sdk
```

The seam already exists and was built for this — `AgentRuntime` in
`apps/gateway/src/runtime/types.ts` is deliberately about "own a session, emit
`SyncItem`s" and nothing else. An Agent-SDK runtime is a translation layer from
the SDK's event stream to Anthropic-native content blocks, which is the same
job `pi-events.ts` already does for pi, against a stream that is *closer* to the
target shape rather than further from it.

- **Cost:** the Agent SDK bucket, at full API rates. This is the whole reason
  the tmux path exists, so this is not a default — it is a per-agent choice.
- **Work:** one runtime module plus its translation tests. No dashboard change
  (the backend selector already exists per session), no schema change beyond a
  third value for `Agent.runtime`.
- **Gets you:** Claude Code's harness — its tools, its skills, its context
  management — with pi's structured plumbing and none of the tmux failure modes.
- **Where it fits:** low-volume, isolation-sensitive work where the tmux path
  hurts most — cron fires, one-shot dispatch agents, anything that currently
  loses turns to send-keys drift. Not the 24 interactive sessions; those are
  exactly what the Interactive bucket is for.

Shape B is the honest reading of "run the pi 底座 with Claude Code": it is Claude
Code *inside the pi-shaped seam*, rather than Claude Code *underneath pi*.

### Shape C — the channel plugin (what openclaw and hermit-agent already do)

**This section corrects the two shapes above.** They assumed the only way to
drive Claude Code programmatically is `-p` / the Agent SDK, and therefore that
structured plumbing costs the Agent SDK bucket. That is wrong, and the
counter-example is this fleet's own previous generation.

`create-hermit-agent`'s template — the openclaw-era layout every current agent
was reshaped from — starts an agent like this:

```bash
tmux new-session -d -s "claude-$AGENT" \
  "cd $DIR && claude --dangerously-skip-permissions \
     --channels plugin:telegram@claude-plugins-official"
```

Interactive `claude` in a pane, so **Interactive bucket** — and yet nothing
types into that pane. Inbound messages arrive over `--channels`.

**The contract.** A "channel" is an ordinary MCP server (the reference one is
`claude-channel-telegram`, shipped as a plugin with a `.mcp.json`) that speaks
three notification methods. All three are present in the shipping CLI binary
(verified against 2.1.222):

| Direction | Method | Payload |
| --- | --- | --- |
| channel → Claude | `notifications/claude/channel` | `{content, meta:{user, ts, image_path?, …}}` — arrives in the session as a `<channel source="…" user="…" ts="…">` turn |
| Claude → channel | `notifications/claude/channel/permission_request` | `{request_id, tool_name, description, input_preview}` |
| channel → Claude | `notifications/claude/channel/permission` | `{request_id, behavior: 'allow' \| 'deny'}` |

Outbound content is not a notification — it goes back through ordinary MCP
tools the channel registers (`reply`, `edit_message`, `react`,
`download_attachment`), which the model calls.

So the openclaw generation had, on the Interactive bucket: **push-based
structured inbound, no send-keys, no uuid drift, and a real permission
round-trip.** hermit-ui does not use `--channels` anywhere — it replaced that
with `tmux send-keys` for inbound and a JSONL tail for outbound. Which means the
send-keys failure class the pi runtime was adopted to escape is not intrinsic to
Claude Code at all; it is something this rewrite reintroduced.

**What it would and would not fix here.**

- **Inbound: fixed.** `chatTick` would POST a notification to the session's
  channel instead of typing into a pane. `robustSubmit`, the dropped-keystroke
  retry, and the composer-detection heuristics all go away.
- **Permissions: better than today.** A typed request/response pair replaces the
  PreToolUse shell hook, and it sees every tool rather than whatever a matcher
  pattern covered.
- **Outbound: not fixed, and don't try.** The channel only carries what the
  model *chooses* to send via `reply`. The dashboard renders full transcripts —
  thinking, tool calls, results — which only the JSONL tail provides. The right
  shape is channel-for-inbound plus the existing tail for the transcript, not a
  swap.
- **Cost: nothing.** Same interactive session, same bucket.

**The caveats, stated plainly.** `--channels` is **not in `claude --help`** — it
is in the binary (alongside `--dangerously-load-development-channels`, which is
how you would load a local unpublished channel during development), but hidden.
That makes it an unsupported surface that can change without notice, unlike the
Agent SDK. This fleet already carries a local patch to the official telegram
channel's orphan watchdog (`patch-telegram-plugin.sh`, upstream PR stalled a
month because the repo auto-closes external PRs), which is fair evidence the
surface is young. And the official plugin is deliberately single-user; a hermit
channel would be our own server, so that constraint is theirs, not ours.

## Recommendation

1. **Don't build the shim.** Fronting Claude Code as `/v1/messages` for pi fails
   on both counts — it bills the Agent SDK bucket, and an agent cannot serve as
   a model without nesting two loops and stranding pi's tool schemas.
2. **Shape C is the answer to "Shape B without API billing."** A hermit channel
   plugin gives interactive Claude Code sessions push-based structured inbound
   and typed permissions at zero marginal cost — restoring what the openclaw /
   `create-hermit-agent` generation already had, pointed at the dashboard
   instead of Telegram. Scope it to inbound and permissions; keep the JSONL tail
   for the transcript.
3. **Spike it behind one agent.** A channel is an MCP server, so the spike is
   small: a server that (a) holds the session's pending-message queue, (b)
   emits `notifications/claude/channel` when `chatTick` has something to
   deliver, (c) registers no outbound tools at first. Load it with
   `--dangerously-load-development-channels` on one agent, confirm a message
   lands as a `<channel …>` turn without any `send-keys`, then decide whether
   the permission round-trip replaces the PreToolUse hook. Nothing else in
   `chat-runner` changes until that works.
4. **Shape A remains the answer for "a pi agent that thinks like Claude"** —
   Settings → Pi Runtime, today, at API rates, decided per agent on cost.
5. **Shape B (the Agent SDK runtime) is now the fallback, not the plan.** It is
   worth keeping on the shelf for the case where the channel surface changes
   under us, since `AgentRuntime` accommodates either.

## What would change this

Two independent facts hold this up, and each has a different failure mode.

The **bucket split** is a policy fact recorded in June 2026 (L1) that this repo
cannot verify. If Anthropic ever exposes a subscription-billed model endpoint,
Shape A becomes free and Shape C stops mattering.

The **channel surface** is undocumented — present in the binary, absent from
`--help`. It can move or disappear in any Claude Code release, and unlike the
Agent SDK there is no compatibility promise to lean on. Anything built on it
should be one module behind `AgentRuntime`, so that losing it costs a runtime
implementation rather than the fleet. Re-check `--channels` and the three
notification methods against the bundle at each Claude Code upgrade; the probe
is `strings <bundle> | grep notifications/claude/channel`, and it takes a
minute.
