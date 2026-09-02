# Running Claude Code on the Agent SDK

Status: implemented, 2026-08-21. Supersedes the recommendation in
`pi-on-claude-code-design.md`, whose Shape B this is.

## What changed

`pi-on-claude-code-design.md` (2026-08-06) ruled the Agent SDK out on one
ground, and named the fact that would reverse it:

> The **bucket split** is a policy fact recorded in June 2026 (L1) that this repo
> cannot verify.

It reversed. Anthropic announced on 2026-05-13 that from 2026-06-15 the Agent
SDK, `claude -p`, GitHub Actions and third-party apps would draw on a separate
monthly credit at API rates — and **paused the change on the day it was due to
take effect**. SDK traffic draws on the ordinary subscription windows again.

Verified on this fleet's own account rather than taken from the announcement.
One SDK turn reports:

```
apiKeySource          = none          ← no API key; the /login OAuth credential
subscriptionType      = Claude Max
apiProvider           = firstParty
rate_limits_available = true
  five_hour            : utilization 4     ← the same windows an interactive
  seven_day            : utilization 6        session reports
  seven_day_oauth_apps : null              ← the would-be SDK bucket, empty
  extra_usage.is_enabled : false
```

**Paused is not cancelled.** `collect/sdk-bucket.ts` re-reads those windows
hourly — a control request against a session that is already running, so it
costs nothing — and alerts the moment a `*_oauth_apps` window becomes populated.
That is the fleet's own answer to "a policy fact this repo cannot verify": now
it can.

## Why the SDK rather than the pane

The two backends run the same binary, on the same login, against the same
transcript. The difference is entirely in how the gateway talks to it, and every
item below was a class of bug on the pane, not a theoretical improvement:

| | `claude-tmux` | `claude-sdk` |
| --- | --- | --- |
| Deliver a message | type it, then prove a turn started; retry on a dropped keystroke; detect a widget that stole focus; probe whether the process still reads stdin at all | one function call |
| Which transcript is this? | reserve a uuid before spawning, sniff for a new file, parse it back out of `ps` argv, exclude uuids other sessions hold | the `init` frame says so |
| Is a turn running? | scrape `esc to interrupt` off the screen, OR transcript freshness, OR an unmatched `tool_use`, OR a hook's state file — because each fails on a different pane width | the CLI's own turn-boundary frame (see "Is a turn running?" below) |
| Interrupt | send Escape, hope | an RPC with a receipt |
| Slash-command output | poll `capture-pane` and guess from the footer when it finished | arrives as a message |
| Change model | kill the pane, respawn, lose the warm context | `setModel()` |
| Attach an image | write the path and pay a `Read` round-trip — `send-keys` carries no binary | the bytes go in the request |
| Wake a 300k-token session | answer an in-TUI "resume from summary / full" prompt; budget 240s + 60s per MB | measured 3.2s to a resumed answer |

The pane is kept, as a per-session choice, for the one thing it genuinely does
better — see the next section.

## Two sources, one funnel

An SDK child is a gateway subprocess, so a gateway restart ends it, while a tmux
pane outlives one. A turn that completes in that gap would reach the transcript
with nobody listening.

(Since 2026-09-02 a session host can hold the child instead, so the child itself
survives — see `session-host-design.md`. The funnel below did not become
redundant: it is what fills the gap while no gateway is attached, and it is the
only thing that covers a host restart, a crash or a machine reboot.)

So the runtime reads **both**: the SDK message stream (live, typed, immediate)
and a `tail -F` of the session's JSONL (the backstop that covers the gap). They
carry the same records under the same uuids — the SDK's `uuid` *is* the
transcript's — so one `seen` set dedupes them exactly and whichever arrives first
wins.

The result is more robust than either alone, and than the pane: the pane path had
only the tail, with seconds of latency and every uuid-identification problem in
the table above.

## Migration, and why it is reversible

`ChatSession.claudeSessionId` is one column shared by every backend, and moving
between backends normally has to clear it — a codex thread id is meaningless to
pi, and fatal to claude. The two Claude Code drivers are the exception: the id is
the same `<uuid>.jsonl`, so `planRuntimeSwitch` preserves it across that pair
specifically (`sameConversation`).

Because both paths translate the same records into the same `externalId`, and
`/api/sync/chat-message` upserts on `(sessionId, externalId)`, a session moved in
either direction re-emits its history onto the rows that already exist rather
than duplicating the conversation. Moving is a per-session decision, and it is
not a one-way door.

Two guards make an *implicit* move safe as well, because `DEFAULT_RUNTIME` is now
`claude-sdk` and an agent with no stored preference reaches the SDK without any
switch flow running:

- the switch flow hibernates the outgoing process before the incoming one starts;
- and independently, `ensure()` kills a tmux pane it finds still running for the
  session, so two Claude Codes can never hold one transcript.

## Bugs this surfaced

Three, all pre-existing, all found by integration-testing against a real CLI
rather than by reading code. The first two were latent in the pane path too.

1. **`encodedProjectDir` encoded only `/`.** Claude Code maps *every*
   non-alphanumeric character to `-` (measured: `a_b.c d-e+f@g(h)` →
   `a-b-c-d-e-f-g-h-`, with no collapsing of runs). Any agent directory
   containing an underscore, a dot or a space resolved to a directory Claude Code
   never writes to — so its transcript read as missing, the context bar read
   empty, and a wake concluded the conversation had been pruned and started a
   fresh one on top of real history.
2. **It also did not resolve symlinks.** Claude Code encodes the path it actually
   lands in, so anything under `/tmp` or `/var` on macOS had the same outcome.
3. **A zeroed usage blanked the context bar.** Claude Code answers `/context`,
   `/status` and friends locally and still emits them as assistant messages,
   carrying a usage object with every field `0`. Newest-first scanning took that
   as the reading, so one slash command flattened the context bar of a session
   20k tokens deep until its next real turn.

## Switching model mid-conversation

`setModel()` is a control request, so a running session changes model without
losing anything: no respawn, no re-read of the transcript, no cold context. That
turned a capability into a product surface — the model chip in the chat header
(`components/chat/model-chip.tsx`), one click from the reply that made you want
a different model.

Three things make it honest rather than a switch that appears to do something:

1. **The catalogue is the machine's own.** `supportedModels()` is answered out
   of the CLI binary, and the aliases in it (`opus[1m]`, `sonnet`) resolve to
   whatever that claude thinks those mean today. The gateway reports the list
   off the first `init` frame it sees (`/api/sync/claude-models` →
   `Machine.claudeModels`) and then only when the answer changes. Measured, not
   assumed: `init` arrives with the first USER MESSAGE, not at spawn — so a
   machine that has never taken a turn shows the dashboard's fallback list, and
   its first message replaces it for good. A catalogue
   hardcoded in the dashboard would be wrong the day a model shipped, and would
   fail as a switch that silently did nothing.
2. **One spelling of "unset".** The catalogue's `default` row stores NULL on the
   session — the same value the resolver already reads as "no pin" — and reaches
   the SDK as `setModel(undefined)`. Un-picking a model therefore restores this
   CLI's default immediately, instead of waiting for something to respawn the
   child.
3. **The pin is not the running model.** `init` answers with a resolved id
   (`claude-sonnet-5`) while we asked for an alias (`sonnet`), so the handle
   keeps both: `modelPin` is what a change is compared against, `model` is what
   the CLI reports. Comparing against the reported id made every check disagree
   and re-sent `setModel` for a model the session was already on.

The pane driver is deliberately excluded, in the UI and again on the server: it
takes its model from that machine's `~/.claude/settings.json` and ignores the
column, so a picker there would name a model nothing was running.

## Testing

- `claude-sdk-events.test.ts` — the translation vocabulary, including the
  property the migration rests on: an SDK message and its transcript record
  produce the same row.
- `claude-sdk.test.ts` — content assembly and, above all, `resumableUuid`:
  which conversation a session resumes is the single decision that loses history
  when it is wrong.
- `attachments.test.ts` — per-type attachment advice, shared by both backends.
- `lib/claude-models.test.ts` (dashboard) — the catalogue's fallback, the rows
  that cannot render, and that a pin the machine no longer offers still shows as
  itself rather than as some other model.
- `server/runtime-switch.test.ts` (dashboard) — a model change on Claude Code
  plans NO restart (the whole point), is still refused mid-turn, and the same
  change on pi still needs a fresh child.
- `sdk-bucket.test.ts` — the billing sentinel's predicate, against a payload
  captured from a live probe.
- `claude-sdk.itest.ts` — **a real Claude Code**, run with
  `npm run test:integration` from `apps/gateway`. Kept out of `npm test` (which
  must stay offline and fast) by the `.itest.ts` suffix. It is what actually
  establishes that the CLI resumes, interrupts, loads the agent's `CLAUDE.md`,
  understands an inlined image, and that the two message sources agree.

Run the integration suite before shipping any change to this runtime. Every
property it checks is one the unit tests cannot see.

## Is a turn running?

The first answer this runtime shipped was "a status frame, plus a submit
counter", ORed — `pending > 0 || statusBusy`. Both halves were measured against
2.1.238 in August 2026 and **neither holds**:

- **`statusBusy` never fires.** `system/status` frames only arrive with
  `includePartialMessages: true`, which this runtime deliberately leaves off
  (the dashboard renders whole rows, not token-by-token rewrites). Two full
  probe runs saw zero status frames. Turning partials on does not rescue it:
  with them on, `status` stayed `'requesting'` for the whole of a 35-second
  foreground Bash rather than clearing, so it is wrong in both directions.
- **`pending` only counts turns WE submitted**, and `submit()` has exactly one
  caller — the chat runner draining queued dashboard messages. The CLI starts
  turns of its own: a `/loop` wakeup, an auto-resume continuation, and above all
  the re-invocation that follows a background task completing. Measured: a
  backgrounded Bash finished at 28s, the model woke and ran a full turn — fresh
  `init`, a tool call, a reply, its own `result` — with `pending` at 0 for every
  second of it.

The visible cost was a session that went **green "ready" in the dashboard while
it was still working**, because the 8-second snapshot sampled `isWorking()`
during exactly that window. Worse than cosmetic: `state` also gates the
message-queue dispatch, the mid-turn guard on backend/model switches, and the
cleanup sweep's "don't archive a busy session" check.

The CLI has an authoritative answer and had it all along. `system/session_state_changed`
carries `state: 'idle' | 'running' | 'requires_action'`, documented in the SDK
types as:

> 'idle' fires after heldBackResult flushes and **the bg-agent do-while exits** —
> authoritative turn-over signal.

That clause is the whole point: it is a statement about the turn, not about the
API request inside it, and it waits for the background-agent loop rather than
firing on the first `result`. Measured, `running` arrives ahead of the turn's
`init` frame — including for the turns nothing submitted — and `idle` lands
immediately after that turn's `result`, or after an interrupt's
`error_during_execution`.

It is **off by default**, gated behind `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`,
which `ensure()` sets in the child's env. Purely additive: the frame produces no
chat row (`translateSdkMessage` skips it, like every other system subtype it does
not render).

Two deliberate choices in how it is consumed:

1. **It is ORed in, not trusted outright.** `sessionBusy === false` does not force
   the verdict to false — a missed or late frame would then be able to *contract*
   it, and this predicate's contract is that a wrong answer lands on the busy
   side. As an OR the new signal can only ever ADD "working", and a CLI that
   ignores the env var degrades to the previous behaviour instead of to "always
   idle".
2. **`interrupt()` pre-empts it to `idle`.** Stop must read as stopped the instant
   the user presses it, and the CLI's own frame is a beat behind. Safe here in a
   way `pending = 0` is not: if the interrupt did not take, the CLI's next
   `running` frame puts the session straight back to busy.

Regression cover: `claude-sdk-activity.test.ts` encodes the measured frame
ordering (including that a `result` must NOT end the session), and
`claude-sdk.itest.ts` proves against a real CLI that a background-task
continuation reads as working with nothing submitted — the property no offline
test can see, since it depends on the installed CLI still honouring the env var.

## Saying what the session is doing

`isWorking` is a boolean because that is all a scraped terminal spinner can
support. The SDK stream carries much more, and `claude-sdk-activity.ts` folds it
into one small structure the dashboard renders in place of the word "working":

| shown | from |
| --- | --- |
| `Bash · 47s` | the `tool_use` → `tool_result` pair, timed |
| `code-reviewer` | `task_started` / `task_progress`, with its current tool |
| `retrying 2/5, 12s` | `api_retry` — attempt, ceiling and the delay the API asked for |
| `compacting` | the CLI's own `status` frame |
| `Read · 3s +2 bg` | `background_tasks_changed`, alongside the foreground |

The retry line is the one the pane could not produce at all: a rate-limited
session simply looked hung, and nothing on screen distinguished waiting from
wedged.

**Not `tool_progress`.** The SDK has a message carrying `elapsed_time_seconds`
that looks like the obvious input, and measured against 2.1.238 it does not
arrive for an ordinary foreground Bash — a 20-second one produced none. The
`tool_use`/`tool_result` pair is always there (it is what the transcript is made
of, and what `pane.ts:transcriptToolRunning` already derives for the tmux path),
so that is the primary signal; `tool_progress` sharpens the elapsed time when it
does show up.

It rides `getSession` / `sessionDetail`, deliberately NOT the 5s `listSessions`
poll — the same rule loopState is held to (P1-2). The only reader is the session
someone has open; the sidebar dot needs `state`, which it already has.

## Long commands, and not wedging a turn on one

Three layers, in the order they get a chance to act.

**1 — start it in the background (`PreToolUse` hook).** A short list of commands
whose whole job is to take minutes (`npm ci`, `docker build`, `pytest`, …) get
`run_in_background: true` before they ever block. Only when the model asked for
neither a background run nor its own timeout: either is a decision about its own
command, and overriding it would be the harness second-guessing the agent.

A hook, **not `canUseTool`** — under `bypassPermissions`, which every dashboard
session uses, the SDK never consults canUseTool and says so:

> canUseTool will not be invoked: permissionMode 'bypassPermissions'
> auto-approves every tool call before the callback is consulted. To gate every
> tool call, use a PreToolUse hook instead.

Hooks fire regardless of permission mode, and `updatedInput` genuinely rewrites
the call — verified: a hook turned `echo ORIGINAL` into `echo REWRITTEN` and the
shell ran the rewritten one.

**2 — notice (the activity tracker above).** A foreground Bash's elapsed time is
known second by second, so "which command is holding this up" is answerable
without opening a terminal.

**3 — move it aside (`backgroundTasks(toolUseId)`).** Anything still in the
foreground after `HERMIT_BASH_BACKGROUND_AFTER_MS` (default 180s) is backgrounded
and announced in the chat. This is **not** a kill: the blocking tool returns
"running in the background" immediately, **the turn continues**, and the command
reports when it settles. Measured end-to-end — a 60s command backgrounded at
20s, the turn carried straight on, and the model collected the finished output
itself 40 seconds later.

The pane had no equivalent. Escape killed the whole turn and lost everything the
model had done; Ctrl+B existed but was a keystroke into a TUI, i.e. the same
channel that loses keys.

**pi is different, and cannot do this.** `pi-rpc` exposes `client.abort()` and
nothing finer — whole-turn abort, the same granularity as Escape, with no
per-tool backgrounding and no elapsed-time events. On pi the only defence is
upstream: the mode's tool allowlist, or wrapping the command. That is a property
of pi's harness, not of how the gateway talks to it.

## Completing the rollout

Making claude-sdk the default changes what an agent with NO stored preference
resolves to. Every agent on this fleet has one — `claude-tmux`, written before
this backend existed — so the deploy moved no running conversation, which is
what made it safe to ship at all.

`scripts/migrate-agents-to-claude-sdk.mjs` is the separate, reviewable step that
does move them. It defaults to a dry run and reports the real blast radius,
which is smaller than the session count suggests: measured on 2026-08-21, of 47
claude-tmux sessions, 26 inherit their agent's default and would move, while 21
pinned a backend of their own and are untouched by it (those need the
per-session picker). A session mid-turn refuses the switch and moves on its next
message instead.

    node scripts/migrate-agents-to-claude-sdk.mjs                    # dry run
    node scripts/migrate-agents-to-claude-sdk.mjs --apply --only asst  # a canary
    node scripts/migrate-agents-to-claude-sdk.mjs --apply            # the rest
    node scripts/migrate-agents-to-claude-sdk.mjs --apply --to claude-tmux  # back

Rolling back is the same command reversed, and it costs nothing: both drivers
write the same transcript, so a session moved either way resumes its own
history.

## What would change this

The billing split returning is the only thing that invalidates the backend
outright, and it is watched (`collect/sdk-bucket.ts`). If it does return, the
recovery is a per-agent switch back to `claude-tmux` — which is why that backend
is kept rather than deleted, and why the switch preserves the conversation.
