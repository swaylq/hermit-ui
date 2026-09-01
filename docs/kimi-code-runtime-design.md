# kimi-code: Moonshot's own CLI as a fifth composable harness

Status: implemented, 2026-08-27. Follows the codex pattern
([codex-runtime-design.md](codex-runtime-design.md)) for its shape and the dsh
pattern ([dsh-runtime-design.md](dsh-runtime-design.md)) for its event
translation. Measured against `@moonshot-ai/kimi-code` **0.38.0**.

## What Kimi Code is, and why it is a harness rather than a model

The fleet already runs Kimi's K3 — through `claude-sdk` pointed at
`api.kimi.com/coding` ([arch note](https://github.com/swaylq/hermit-ui), fleet
memory `arch_claude_sdk_composable_kimi_k3`). That gives you Kimi's *model*
inside Anthropic's *agent*: Claude Code's tools, Claude Code's skills, Claude
Code's system prompt.

`kimi` is the other half — Moonshot's own agent. Its own tool set, its own
sub-agents (`coder`, `explore`, `plan`), its own skills and hooks and MCP
config, its own compaction policy, and a prompt written for the model it ships
with. Running K3 under it is a materially different thing from running K3 under
Claude Code, in the same way codex is a different thing from the pane.

So it is a harness: `RUNTIME_KINDS` gains `kimi-code`, and because the CLI can
be pointed at an endpoint it also joins `CUSTOM_HARNESSES` — one credential from
Settings → Models drives it and `claude-sdk` alike.

Source: [github.com/MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
(MIT). Docs: [moonshotai.github.io/kimi-code](https://moonshotai.github.io/kimi-code/en/).

## Shape: one process per turn, resumed by session id

Exactly codex's and dsh's shape. Each turn spawns

```
kimi [-r <sessionId>] --output-format stream-json -p <text>
```

with `cwd` set to the agent's directory — there is **no `--cwd` flag**, the CLI
reads `process.cwd()`. The child runs to completion and exits; the conversation
lives in kimi's own store, and the session id rides the DB's `claudeSessionId`
column, which is what `RuntimeSession.externalSessionId` is for.

Consequences, all the same as codex's: hibernate and restart are nearly free
(no process to drain), a gateway restart is survivable with no pointer file, and
a model change needs no teardown — the next child is simply born with a
different one.

**The agent's `AGENTS.md` is read from that cwd** — verified, not assumed. That
is the whole reason spawning with `cwd` set is enough: without it every hermit
agent would run here as a stranger, with the same tools and no identity. Note it
is `AGENTS.md`, not `CLAUDE.md`; on this fleet an agent's behavioural rules live
in the former and the latter is the Claude-specific bootstrap, so the split
happens to land right.

## Auth: the one path that writes nothing to disk

This is the part worth reading before changing anything here.

**The CLI does not read `KIMI_API_KEY` from the shell.** Its docs say so three
times. Credentials normally live in `~/.kimi-code/config.toml`, as either a
plaintext `api_key` or an OAuth token from the device-code login — and
`AuthSummaryService.ensureReady` refuses to start a run when neither is there,
*before* any adapter is constructed, so the fallback that does read
`process.env` never gets reached. Measured: a config declaring the provider with
no key fails with `provider kimi-code has no credential configured`.

Writing the fleet's key into a config file is what every other backend here
avoids, so this backend is built on the one documented exception:

| variable | effect |
|---|---|
| `KIMI_MODEL_NAME` | master switch; becomes the model id, and pins `defaultModel` |
| `KIMI_MODEL_API_KEY` | the credential — the only shell-read key that survives the auth gate |
| `KIMI_MODEL_PROVIDER_TYPE` | `anthropic` / `openai` / `openai_responses` |
| `KIMI_MODEL_BASE_URL` | the endpoint |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | window; **default is 262144 for every env model** |
| `KIMI_MODEL_MAX_OUTPUT_SIZE` | read on the anthropic protocol only |
| `KIMI_MODEL_THINKING_EFFORT` | `low`…`max` |

Together these synthesise an in-memory provider `__kimi_env__` and alias
`__kimi_env_model__`. The overlay is applied to the *effective* config only and
stripped from every write path. Verified with a fresh empty `KIMI_CODE_HOME`:
the run answers, and **no `config.toml` is created at all** — asserted by
`kimi-code.itest.ts`.

Three traps this mechanism sets:

1. **Do not pass `--model`.** The overlay already pinned `defaultModel`, and
   `-m` is an exact-key lookup against the `[models]` table — which is empty
   here, so any value fails with `Model "k3" is not configured in config.toml`.
   The model is `KIMI_MODEL_NAME`. Pinned by a test.
2. **`KIMI_MODEL_MAX_CONTEXT_SIZE` is not optional.** Left unset, every
   env-configured model is assumed to be 262144 — so a k3 session would compact
   at a quarter of its real 1M window, silently. It comes from the credential's
   `modelLimits`, falling back to the shared family table.
3. **A blank `base_url` is not harmless.** Settings → Models allows one (for dsh
   it means "the harness supplies its own catalog"); here the CLI would fall
   back to the provider definition's default, which for the anthropic protocol
   is `api.anthropic.com` — i.e. a blank field would post a Moonshot key to
   Anthropic. `kimiSpawnEnv` refuses instead, and `submit` says which field is
   missing.

`CONFLICTING_KIMI_VARS` are deleted from the child's env for the mirror-image
reason: with no `KIMI_MODEL_BASE_URL`, the CLI resolves the endpoint through the
provider definition's env names, so a stray `ANTHROPIC_BASE_URL` inherited from
the gateway would redirect a Kimi session somewhere else with nothing on screen
to say so.

### Why never `type = "kimi"`

kimi's own provider type speaks OpenAI chat-completions and appends
`/chat/completions` to the base URL, so the fleet's stored
`https://api.kimi.com/coding` **404s** under it while the same URL answers under
`anthropic` (both measured). Mapping from the credential's `api` field instead
is what keeps ONE credential serving `claude-sdk` and this backend identically,
which is the whole point of Settings → Models.

## Permissions

`-p` cannot be combined with `--yolo`, `--auto` or `--plan` — the CLI rejects
the combination at startup. It does not need them: print mode installs an
approval handler that returns `approved` and a question handler that returns
null, so **a headless run can never block on a prompt**. Static
`[[permission.rules]]` deny rules would still apply; there is no config.toml
here, so there are none.

That is a real difference from the claude path, where
`--dangerously-skip-permissions` is a flag someone could forget. Here it is the
mode's definition.

## The wire: five line kinds, and one that carries the id

`--output-format stream-json` writes one JSON object per line to **stdout**, in
an OpenAI-chat-message shape:

```jsonc
{"role":"meta","type":"system.version","version":"0.38.0"}
{"role":"assistant","content":"…","tool_calls":[{"type":"function","id":"tool_…","function":{"name":"Bash","arguments":"{\"command\":\"…\"}"}}]}
{"role":"tool","tool_call_id":"tool_…","content":"…"}
{"role":"meta","type":"turn.step.retrying","failed_attempt":1,…,"status_code":429}
{"role":"meta","type":"session.resume_hint","session_id":"session_…","command":"kimi -r session_…"}
```

Five facts about it, each of which cost a measurement:

- **stderr is not an error channel.** The agent's own tool output goes there
  (`echo HELLO` prints `HELLO` on stderr while stdout stays pure JSONL), along
  with "resuming session" notices. Merging the two would corrupt the stream;
  treating a busy stderr as a failure would flag every turn that ran Bash.
- **One assistant line can be two rows.** `content` and `tool_calls` are each
  omitted when empty and both appear together when the model wrote text *and*
  called a tool in one step. Reading it as one row drops whichever half is read
  second.
- **`function.arguments` is a JSON-encoded string**, not an object.
- **Thinking never appears.** `writeThinkingDelta` is a no-op in JSON mode, so
  there is no `thinking` block to translate and none is invented.
- **The resume hint arrives LAST** — the opposite of dsh's `hello`. A brand-new
  session therefore has no id at the moment its first rows are emitted, which is
  why `externalId`s are scoped by a per-turn tag rather than by the session id.
  kimi's tool-call ids are globally unique, so they double as `tool_use` ids and
  no cross-turn call map is needed.

`turn.step.retrying` is the one meta line that reaches the chat. It is the
difference between a session that looks hung and one that is waiting out a 429 —
the most common thing a Kimi subscription does under load.

## Usage: read back out of kimi's own log

The stream-json protocol carries **no usage at all**. The numbers exist one
level down, in the session log the CLI keeps for its own replay:

```
$KIMI_CODE_HOME/
  session_index.jsonl                       # sessionId → sessionDir → workDir
  sessions/wd_<slug>_<sha256[:12]>/<sessionId>/
    state.json
    agents/main/wire.jsonl                  # the events
```

Two event types matter:

```jsonc
{"type":"usage.record","usage":{"inputOther":4090,"output":34,"inputCacheRead":16896,"inputCacheCreation":0}}
{"type":"token_counting.measured","length":3,"tokens":21020}
```

The counters are **disjoint**, exactly like dsh's, so billed input is the sum of
the three. `token_counting.measured` is live window occupancy — the context
bar's basis; a cumulative sum there would render as a bar that only ever fills
up.

Two implementation notes:

- The log is located through `session_index.jsonl`, never by rebuilding the
  directory name. That name embeds a sha256 the CLI computes, and reproducing it
  is the kind of coupling that breaks silently the day they change the slug rule.
- `scanWire` reads from a remembered byte offset, so the after-every-turn
  refresh costs only the bytes that turn appended. A truncated file (a session
  reset) resets the offset rather than reading on from the middle of a line.

`storedUsage` serves a session with no live handle. Its first call for a session
reads the whole log — a cumulative total cannot be had any other way — and
caches the offset and totals, so every later call reads only what was appended,
which for a session with no child is nothing at all.

That cache is not an optimisation. `session-snapshot` calls this on every open
handle-less session, every 8 seconds, forever; after a gateway restart with ten
open kimi sessions the uncached version would re-read ten multi-megabyte logs on
the event loop six hundred times an hour. codex solves the same problem by
bounding its read to a 256 KiB tail; this keeps the whole-file answer and pays
for it once.

`usage()` refreshes on the same incremental basis rather than only at the end of
a turn, so the context bar moves during a long tool-heavy turn instead of showing
the previous one's numbers — the same reason codex refreshes inside `usage()`.

## What is deliberately not wired

- **`compact`.** kimi compacts itself (`[loop_control] reserved_context_size`),
  and its `/compact` is a TUI command — a slash command in `-p` is sent to the
  model as literal text. The handler says so rather than no-op'ing, because a
  silent no-op is indistinguishable from a wedged session.
- **`kimi acp` and `kimi web`.** Both are real, official, and better surfaces for
  token-level streaming and bidirectional control than screen-scraping `-p`. If
  this backend ever needs partial-message streaming — `-p` only flushes at step
  boundaries — ACP is where to go, not a finer parse of this protocol.

## The hermit tool surface (wired 2026-09-01)

kimi has MCP, so the same stub every other backend mounts is declared in kimi's
**user-global** `$KIMI_CODE_HOME/mcp.json` (`ensureHermitMcpConfig`, merged —
the human's own servers are preserved, a malformed file is left alone, the
write is atomic and skipped when current). That file is the one location that
loads WITHOUT the workspace-trust gate: project-level mcp.json files wait for a
trust prompt a headless turn can never answer (measured — a project-local probe
server simply never registered).

Two mechanism facts make it clean:

- **No `env` block in the entry.** kimi spawns a stdio MCP server with its own
  whole environment plus the config's overlay, so the HERMIT_SESSION_ID /
  HERMIT_KEY / HERMIT_DASHBOARD_URL set on the kimi child reach the stub
  untouched, and the machine key never sits at rest in the file. The corollary:
  the human's interactive `kimi` loads the entry too, gets a stub with no
  HERMIT_SESSION_ID — and the stub serves ZERO tools in that case, connected
  and invisible instead of an error.
- **Print mode auto-approves MCP calls** (measured), and tools arrive named
  `mcp__hermit__<name>` — the qualified name is also what an agent profile's
  `tools` allowlist gates by (measured both directions), which is how a
  pure-chat kimi session keeps the read-only half of the surface plus
  `memory_write` while the stub itself drops the cron mutations.

`hermitTools: false` (a cron fire) sets none of the env, so the same mcp.json
entry yields a zero-tool stub — no second code path. The entry's
`toolTimeoutMs` (4h5m) sits just above the stub's 4h ask ceiling, same as the
claude path.

## The watchdog's third opinion (2026-09-01)

Stdout silence + a quiet session log tree still had one blind spot: a SINGLE
long model response. kimi flushes its wire log at step boundaries, and one k3
response at max thinking effort has been measured at 401s — nothing caps it
under the 15-minute budget, and the first-turn kill of session cmte4wr4 died to
exactly this. Before firing, the watchdog now also asks whether the child
process burned any CPU since the timer was armed (`ps -o time=`, `childCpuMs`).
A process mid-response is parsing a stream and burns CPU; one deadlocked on a
read does not. kimi's subagents run in-process, so one pid covers a swarm. ps
being unanswerable does NOT save a turn — missing data falls back to the old
verdict, because a watchdog that cannot fire is worse than one with a blind
spot — and the failure note only claims "no CPU burned" when ps actually said
so.

## The context bar's denominator (2026-09-01)

`contextWindowFor` now has a kimi-code branch: k3 → 1,048,576, the 256k
variants → 262,144, unknown → 262,144, which is the CLI's own fallback for an
env model with no declared window — a bar that over-reads the window is the
dangerous direction (kimi's compaction arrives first). The gateway half is
already right whenever the credential declares modelLimits, and
pi-model-limits.ts gained the kimi families so a credential that does not still
spawns the CLI with the right `KIMI_MODEL_MAX_CONTEXT_SIZE`.

## Prompts travel on argv, mostly

The CLI takes its prompt as a flag argument and **reads nothing from stdin**, so
argv is the only channel. Argv is size-limited (ARG_MAX is 1 MiB on macOS, and
the environment shares that budget) and visible in `ps` to the user running the
gateway. A pasted document is an ordinary chat message here, so anything over
96 KiB is written to a 0600 temp file and the model is pointed at it instead.

## Where it looks for the binary

`HERMIT_KIMI_BIN`, then `PATH`, then `~/.local/bin/kimi` (where the official
installer puts a self-contained binary), `/opt/homebrew/bin/kimi` and
`/usr/local/bin/kimi` (npm prefixes). The fallbacks exist because a gateway
started by launchd has none of those on its PATH — the single most-repeated
failure on this fleet.

An absent `kimi` is reported into the chat with the install command, not spawned
and surfaced as a bare ENOENT.

## Switching a live session

`kimi-code` sits in `planRuntimeSwitch`'s codex/dsh branch: never a restart,
because there is no long-lived child to tear down. Moving to a different backend
is caught earlier and drops the session id, as for every other harness.

**Known gap, deliberately not papered over.** kimi keeps
`[thinking] keep = "all"`, so a resumed session replays its stored reasoning to
whatever endpoint is configured now. Re-pointing a backend at a different
credential in Settings while a session is live would therefore hand Kimi's
reasoning to somebody else's endpoint — the provider-signed-thinking trap that
already makes a claude-sdk transcript unusable across credentials.

A first version of this guarded against it in `planRuntimeSwitch` and the guard
was dead code: that function is only reached from the session-switch mutation,
`before` and `after` are both resolved against the same machine snapshot, and
`runtimeCredentialId` comes straight off the backend — so within one backend id
the credential can never differ. Editing a backend in Settings does not call it
at all. The branch is gone; the gap is written down here instead. Fixing it
properly means the credential edit path invalidating live sessions, which is a
change for pi, prime and claude-sdk too.

## Verification

`kimi-code.test.ts` covers the pure parts (argv, env mapping, binary
resolution, log scanning) and `kimi-code-events.test.ts` the protocol, against
lines captured verbatim from a real run.

`kimi-code.itest.ts` is the one that matters — real CLI, real endpoint, no
mocks, run with `npm run test:integration`. It asserts what a unit test cannot
see: a turn answers, the session id is stamped back, no `config.toml` is ever
written, the agent's `AGENTS.md` reaches the model, the next turn resumes the
same conversation, tool calls arrive paired, a prompt too large for argv still
arrives, a turn that dies after its first line still reports, a foreign session
id starts fresh instead of failing forever, and the token counters come back out
of the log both live and stored. It SKIPS (not fails) when kimi, the credential
or the secret is absent, so a laptop without a Kimi subscription does not have a
red suite.

### Three bugs this nearly shipped with

All three were the same shape — a turn failing and nobody being told — and all
three are now pinned by a test.

1. **"Did we see any output?"** was the exit handler's first test for failure.
   It reads as reasonable and is silently wrong: the CLI writes its
   `system.version` line before doing anything else, so **every** run has
   produced output by the time it fails, and a turn that died at the auth gate
   reached the user as an empty reply.
2. **Then it keyed on the exit code alone** — and Node reports a signal death as
   `(null, 'SIGKILL')`, so every signal death read as a clean exit. The silence
   watchdog ends a wedged turn exactly that way, so the one case the watchdog
   exists for produced no note at all. (The tell was in the code: the error
   string interpolated `signal ?? code`, and the `signal` branch was
   unreachable.) `turnFailed()` now takes both halves, with `/goal`'s 3-and-6 as
   the one documented exception.
3. **`isFailureNote()` in cron-turn.ts is a prose allowlist**, and a new
   backend's notes have to be added to it or a failed cron on that harness is
   recorded as a success — the regression its own doc comment describes from the
   2026-08-15 codex outage. kimi's two failure notes therefore share the prefixes
   `[kimi could not run this turn]` and `[kimi could not start — …]`, which is
   why those strings are load-bearing rather than phrasing. Its retry note
   (`[kimi — model call failed 429 …]`) is deliberately NOT listed: that is a
   retry the CLI usually wins, and flagging it would colour a turn that finished
   fine.

The itest drives a stand-in binary that reproduces the real failure shape byte
for byte, so (1) and (2) cannot come back silently.
