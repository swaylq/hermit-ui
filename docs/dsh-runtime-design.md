# dsh: a fourth backend, on DeepSeek Harness

Status: implemented, 2026-08-15. Follows the codex pattern
([codex-runtime-design.md](codex-runtime-design.md)); replaces the triage card
([pi-harness-design.md](pi-harness-design.md)) on the backend picker.

## What dsh is, and why it is a backend

DeepSeek Harness (`deepseek-ai/deepseek-harness`, npm `@deepseek-ai/dsh`) is an
agent harness — the Claude Code / Codex layer, not a model. Its architecture is
"everything is a plugin": the tree of ~49 packages (tools, sandbox, session
log, even the agent loop) is composed from layered YAML patches over the Cordis
plugin framework, and a profile is an ordered stack of such layers. Research
notes: `research/projects/deepseek-harness-research/` (hermit fleet).

It is a backend for the same reason codex is: a different vendor's harness with
its own session store (`~/.dsh/sessions/**`, append-only JSONL), its own
credential (`DEEPSEEK_API_KEY`), its own tool vocabulary, and nothing that maps
onto a pi mode. `RUNTIME_KINDS` gains `dsh-exec`; the picker card appears from
the one table in runtime-labels.ts like the others.

## Shape: one process per turn, resumed by session id

dsh ships a one-shot bundle (`dsh --profile headless "task"`) that creates a
fresh agent, prints the final text, and exits — no resume, no event stream.
That is unusable as a chat backend directly, but dsh's own architecture is the
fix: **the runner is itself a replaceable plugin row.**

Each turn, dsh-exec.ts spawns:

```
node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js
     --profile headless --patch <generated overlay>
```

The overlay disables the stock `headless-startup`/`headless-runner` rows and
inserts `apps/gateway/dsh/hermit-runner.mjs`, which:

1. `agents.resume({resumeSessionId})` when `HERMIT_DSH_RESUME` is set,
   `agents.create()` otherwise — dsh's core registry supports both, so
   conversation continuity costs nothing beyond round-tripping the id through
   `ChatSession.claudeSessionId` (the column already means "the backend's own
   session id"; codex keeps its thread id there the same way);
2. submits the task (read from `HERMIT_DSH_TASK_FILE` — argv is visible in
   `ps`, and a chat message can be a pasted document) as an ordinary user
   message and waits for quiescence, exactly as the stock runner does;
3. reports `hello` / `event` / `done` JSON lines on **fd 3**
   (`HERMIT_DSH_EVENTS_FD`), forwarding the session's live `session/event`
   firehose for the types worth rendering — a stray `console.log` from any dsh
   plugin cannot corrupt a channel it does not write to;
4. exits through the launcher's `ctx.appExit`, 0 on `turn/end: completed`.

The runner imports **nothing from dsh packages**: it is loaded by dsh's Cordis
loader from an absolute path outside any node_modules, where bare specifiers
may not resolve. The three helpers the stock runner imports are inlined
(`SessionId()` is an identity cast; `createUserMessage()` is a frozen literal
plus a uuid; `installModelSelection()` is transcribed — its two hooks are what
make `{{model}}` render and pin the request). Mirror of
`@deepseek-ai/dsh-headless@0.1.0-rc.6`; revisit on a dsh upgrade.

Everything else in the headless composition is kept as dsh ships it: bash +
fs + str-replace-editor tools, todo, subagents, skills discovery, its own
compaction (`dsh-compaction-basic`), session persistence, web search. The
persona, tool schemas and loop are dsh's own — the point of running a harness
is to get that harness, not a reskin of ours.

Three things measured against dsh 0.1.0-rc.6, each of which would have been a
quiet bug:

- **A `!!js` expression in a patch's `name` field is not evaluated.** Config
  values take `!!js process.env…`; the loader reads `name` raw, and the row
  died with `name.startsWith is not a function`. So the overlay is generated
  per turn with the runner's absolute path baked in, not checked in with an
  env reference.
- **dsh callIds restart per step** (`call_0`, `call_0`, …) — the same trap as
  codex's per-turn item ordinals. tool_use ids are minted from the event `seq`
  (monotonic per dsh session) and results pair through a callId → id map.
- **`seq` restarts when the dsh session does.** A chat switched away and back
  gets a fresh dsh session whose low seqs would upsert over the old rows, so
  every externalId is scoped by a tag of the dsh session id: `dsh:<tag>:<seq>`.

## The pi endpoint bridge (2026-08-15)

The machine's pi endpoint (Settings → Pi Runtime — hyqubit's claude catalog on
this fleet) is re-declared into every dsh turn as an llm-pi-ai route. This is
nearly free because dsh's `llm-pi-ai` adapter wraps the SAME
`@earendil-works/pi-ai` the pi engine runs on: the provider profile
hermit-pi-extension registers for pi maps field-for-field onto llm-pi-ai's
"hand-declared route" (`api` + `baseURL` + models), so one settings page
serves both backends and the anthropic-messages client is literally the same
code. `piEndpointRoute()` builds the rows from `getPiConfig()`, with real
per-model limits from pi-model-limits (claude-opus-5 is 1M/128k; llm-pi-ai's
declared-route default of 256k would silently shrink it — the same class of
bug pi-model-limits exists for).

Selection ergonomics (`inferDshSelection`): a session's `runtimeModel` naming
one of the endpoint's models implies the route — "claude-opus-5" IS the
choice, and demanding the relay's provider id as a second field would carry no
new information. A provider pin without a model lands on the endpoint's
default model, never on dsh's own deepseek default, which that route does not
serve. Everything else stays on dsh's own catalog; a machine-level default
still works by exporting HERMIT_DSH_PROVIDER/HERMIT_DSH_MODEL in the
gateway's env (the child inherits them and session pins override).

**Settings → Backends → DeepSeek → 模型来源** is the UI for the machine-level
default: 'DeepSeek API key' keeps dsh's own catalog, 'Pi Runtime 端点' points
every UNPINNED dsh session at the pi endpoint's default model. Stored as
`backendsConfig.dshSource`, polled by the gateway (machines.pollBackendsConfig,
30s TTL), and applied as a provider default in front of inferDshSelection — so
it behaves exactly like a hand-pinned provider, and a session that pins its own
model is untouched either way.

Guard that is load-bearing: an `api` value llm-pi-ai does not speak (or any
config field with control characters) SKIPS the bridge instead of emitting it
— an invalid route fails dsh's resolveProfiles at boot, which would kill every
dsh turn on the machine, deepseek ones included. The legacy dropdown value
`openai` maps to `openai-completions`, mirroring the pi path's fix.
cc-subscription mode is not bridged: its Keychain OAuth path is pi-specific,
and llm-pi-ai authenticates routes by API key only.

The route's credential rides the same convention as pi: the secret's NAME is
the env var (`apiKeyEnv: LITELLM_HYQUBIT_TOKEN`), read from the store per
spawn and injected. The rows are emitted even when the secret is missing so a
claude-pinned turn fails with llm-pi-ai's own MISSING_CREDENTIAL naming the
secret to set, rather than with "unknown provider".

Verified live (dsh-e2e.mts, bridge leg): a `claude-haiku-4-5` pin answered
through hyqubit with thinking blocks and cache accounting intact
(cacheReadTokens reported by the LiteLLM relay), and resume held across turns.

## Credentials

`DEEPSEEK_API_KEY`, read from the machine's encrypted secret store per spawn
(60s cache) and injected into the child's env — the exact variable
`dsh-llm-deepseek` documents. Nothing else: model defaults come from dsh's own
profile config (`deepseek-v4-flash` as shipped), and a session's
`runtimeModel`/`runtimeProvider` pins ride `HERMIT_DSH_MODEL`/`_PROVIDER`
through the runner. Setup on a machine is exactly one step:
`secret set DEEPSEEK_API_KEY`.

A missing key is not a broken backend: the turn runs, dsh reports
`MISSING_CREDENTIAL` with its own remediation text, and that lands in the chat
as a system row (verified end-to-end — see below).

`DSH_PERMISSION_MODE=danger-full-access` unless the machine overrides
`HERMIT_DSH_PERMISSION_MODE`: a dashboard session has no TTY, and dsh's default
`workspace-write` posture answers escalations by asking. Same reasoning as the
claude path's `--dangerously-skip-permissions` and codex's `danger-full-access`.

## Usage

dsh's per-call `TokenUsage` is **disjoint** — `inputTokens` is uncached input
only, cache reads/writes are separate — so window occupancy is
`input + cacheRead + cacheWrite` of the latest call, and the session total sums
all four figures. The runner reports the sum over the whole session log in
`hello` (which is how counters survive a gateway restart without reading dsh's
encoded session-file layout) and per call while the turn runs. `costUsd` stays
null: computing a dollar figure from a price table drifts from the invoice the
moment DeepSeek changes pricing. The context bar's denominator keeps the 1M
default — dsh's catalog declares 1M for both deepseek-v4 models.

## What was verified

`apps/gateway/scripts/dsh-e2e.mts`, against the real dsh install, without an
API key (exactly a fresh machine's state), 16/16: fresh session created and
its `session-…` id stamped for resume; the missing key surfacing in the chat
instead of vanishing; turn 2 resuming the SAME dsh session with no re-stamp;
a claude-shaped uuid in `claudeSessionId` self-healing to a fresh session
(agents.resume on a foreign id would fail identically every retry — the
codex-measured brick); interrupt clearing `isWorking`. With a key the same
script asserts real answers and populated usage.

Plus: gateway 360 tests, dashboard 354, both `tsc --noEmit` clean,
`build:check` clean.

## Known gaps

- **No hermit tools.** attach_file / ask / set_session_title reach codex via
  MCP config; dsh has an MCP client package but the headless profile does not
  mount it, so wiring it is its own change. Until then a dsh agent asked to
  "send the file back" cannot — the codex history says the model will claim it
  did anyway, so this is the first follow-up worth doing.
- **Crons.** A cron whose report session runs on dsh falls to the claude-tmux
  path in cron-runner, the same pre-existing gap pi crons have (only codex has
  a cron branch).
- **No storedUsage.** After a gateway restart, token counters re-seed on the
  next turn's `hello` rather than by reading `~/.dsh/sessions` directly (the
  layout encodes path segments and may be zstd-compressed; not worth parsing
  for a number the next turn repairs).
- **Developer preview.** dsh's README promises breaking changes; the runner
  pins nothing but touches only `ctx.agents`/`ctx.sessions`/`agentDefaultModel`
  and the documented event vocabulary. The e2e script is the canary.
