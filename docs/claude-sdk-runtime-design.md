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
| Is a turn running? | scrape `esc to interrupt` off the screen, OR transcript freshness, OR an unmatched `tool_use`, OR a hook's state file — because each fails on a different pane width | a status frame, plus a submit counter |
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

## Testing

- `claude-sdk-events.test.ts` — the translation vocabulary, including the
  property the migration rests on: an SDK message and its transcript record
  produce the same row.
- `claude-sdk.test.ts` — content assembly and, above all, `resumableUuid`:
  which conversation a session resumes is the single decision that loses history
  when it is wrong.
- `attachments.test.ts` — per-type attachment advice, shared by both backends.
- `sdk-bucket.test.ts` — the billing sentinel's predicate, against a payload
  captured from a live probe.
- `claude-sdk.itest.ts` — **a real Claude Code**, run with
  `npm run test:integration` from `apps/gateway`. Kept out of `npm test` (which
  must stay offline and fast) by the `.itest.ts` suffix. It is what actually
  establishes that the CLI resumes, interrupts, loads the agent's `CLAUDE.md`,
  understands an inlined image, and that the two message sources agree.

Run the integration suite before shipping any change to this runtime. Every
property it checks is one the unit tests cannot see.

## What would change this

The billing split returning is the only thing that invalidates the backend
outright, and it is watched (`collect/sdk-bucket.ts`). If it does return, the
recovery is a per-agent switch back to `claude-tmux` — which is why that backend
is kept rather than deleted, and why the switch preserves the conversation.
