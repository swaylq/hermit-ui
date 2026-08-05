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
- **The Interactive bucket is only reachable through the TUI**, which means a
  shim aiming at the free bucket must re-derive exactly the terminal scraping
  pi was adopted to escape — `capture-pane`, `esc to interrupt` matching, uuid
  drift — while *still* hitting both problems above.

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

## Recommendation

1. **Don't build the shim.** It buys nothing at the Agent SDK bucket that an API
   key doesn't buy more simply, and the Interactive bucket is unreachable
   programmatically without re-adopting the terminal scraping pi exists to
   avoid.
2. **For "Claude-quality pi agents" now:** Shape A, today, on the settings page.
   Decide it per agent, on cost.
3. **Before committing to Shape B, measure.** The open question is what the
   Agent SDK bucket actually costs this fleet — the L1 finding is that it *would
   have* blown the cap under v1's all-traffic routing, which says nothing about
   a handful of cron agents. One week of usage data for the candidate agents
   answers it; the usage collectors already record per-session tokens and cost.
4. **Spike, if Shape B survives the measurement.** One session, one agent, no
   fleet exposure: implement `ensure`/`submit`/`isWorking`/`stop` over the Agent
   SDK, translate its events to content blocks, and confirm three things — that
   the transcript renders as well as the tmux path's, that interrupt and
   hibernate behave, and that the usage numbers land in the same collectors.
   The exact SDK option names should be read from the Agent SDK docs at spike
   time rather than assumed here.

## What would change this

The design turns entirely on the bucket split, which is a policy fact recorded
in June 2026 and not something this repo can verify. If Anthropic ever exposes a
subscription-billed model endpoint — or Claude Code grows a supported local
`/v1/messages` surface on the Interactive bucket — Shape A becomes free and this
document's conclusion inverts. Worth re-checking at the next Claude Code release
that touches auth or headless mode; nothing else here needs to change.
