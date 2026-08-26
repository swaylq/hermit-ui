# Which backend runs a cron

A cron fires on the backend its report session uses — or, with no report session,
on its agent's default. Same chain chat resolves, same resolver
(`server/runtime-resolve.ts`). This document is why that took two attempts, and
what is still not covered.

## What was wrong

`cron.listForGateway` gained a runtime field on 2026-08-15, when a backend was
still just a harness name. Six days later `lib/backends.ts` redefined a backend
as **a harness plus a credential**, so that a user could compose pi + Kimi, prime
+ Kimi, dsh + OpenRouter. Cron never caught up, and the two halves failed in a
way that stayed quiet for eleven days:

- the dashboard sent the report session's **raw `runtime` column** — which is now
  a *backend id*, not a harness — and nothing else. No credential, no model, no
  mode.
- the gateway's `cron-runner` special-cased exactly one value, `codex-exec`, and
  its `else` ran everything else on a tmux pane with Claude Code.

So a cron reporting into a pi+Kimi session resolved to the id `pi-kimi`, missed
the `codex-exec` test, and ran on the Claude subscription. The wrong backend
still answers, so the only way to notice was to read the transcript. Crons on
agents whose sessions had moved to Kimi had been billing Claude the whole time.

## How it resolves now

`cron.listForGateway` calls the same `resolveRuntime(session, agent, ctx)` that
`chat.pollPending` calls, and sends the whole answer:

| field | meaning |
|---|---|
| `runtime` | the **harness** to spawn — what `runtimeFor()` dispatches on |
| `runtimeCredentialId` | which Settings → Models entry authenticates it |
| `runtimeProvider` / `runtimeModel` | what it runs as |
| `runtimeMode` | pi's spawn recipe; null everywhere else |
| `backendId` | the name the user picked, for the log line |

The chain is **session's own choice > agent's default > the floor**. A cron with
no report session lands on its agent's default, which is what "this agent's
scheduled work" should mean; the old code ignored the agent entirely and guessed
from machine-wide toggles.

## Three ways to fire

`cron-runner.fireInner` picks one, and nothing else in the file branches on
backend:

- **`codex-exec`** → `runCodexCronTurn`, a one-shot `codex exec`. Kept bespoke
  because it surfaces a refusal verbatim, which is the only reason the
  2026-08-15 quota outage was ever diagnosed.
- **any other AgentRuntime** (`claude-sdk`, `pi-rpc`, `omp-rpc`, `prime-rpc`,
  `dsh-exec`) → `runtime/cron-turn.ts`: `ensure` → `submit` → wait for idle →
  collect → `stop(handle, 'kill')`.
- **`claude-tmux`, or a harness this gateway does not know** → the pane path,
  with the transcript pinning and drift self-heal that only it needs. An unknown
  harness logs a warning first: falling back keeps the cron firing, but on the
  wrong backend, and that must not look intentional.

Since `Agent.runtime` still defaults to `"claude-tmux"` in the schema, an agent
nobody has explicitly moved keeps the pane path it has always had. The new path
is reached by agents and sessions that actually picked something else.

## The part that is easy to get wrong

**No runtime here throws on an expired login or a spent quota.** They emit an
ordinary `system` message and then produce no assistant text:

| backend | what it says |
|---|---|
| pi / omp / prime | `[pi error — the turn did not complete]`, `[pi session ended — …]` |
| dsh | `[dsh could not run this turn]` + the stderr tail |
| claude-sdk | `[gateway] ⚠️ 这一轮没有正常结束：…` |

Collect only assistant text and every one of those is indistinguishable from a
cron that quietly did nothing. That is not hypothetical — reading for text alone
is what recorded "Login expired · Please run /login" as `lastStatus: ok` eleven
times across six agents from 2026-08-10 (`memory/notes/bug_cron_false_ok_synthetic.md`).

So `runRuntimeCronTurn` collects system rows as a **harness note**, reported
verbatim — never swallowed into a generic `no_output`, which would send the
reader to the agent's logs for an answer that was never there.

But the note and the *status* are two different questions, and conflating them
breaks it in both directions:

- **Not every system row is bad news.** claude-sdk narrates a backgrounded
  command (`⏱️ …已转入后台，这一轮继续`), an auto-compaction (`🗜️ …`) and raw
  `local_command_output` through the same channel it reports a dead turn on.
  Treating any note as failure turns an ordinary tool-only run red and fires a
  failure push.
- **A failure that produced text is still a failure.** "Login expired · Please
  run /login" arrives as perfectly ordinary assistant text — which is precisely
  how it was recorded as `ok`. A rule that only fired when there was *no* text
  would miss the original bug entirely.

So `isFailureNote` decides the status and the note is shown either way. An
unrecognised failure still reaches the reader as text; it just does not colour
the status. Today it reaches them as nothing at all.

When a note arrives *alongside* a real report, it is prepended, and that ordering
is load-bearing rather than taste. `parseRunMarkers` reads the last 5 non-empty
lines for `CRON_DONE` / `CRON_NEXT <n>`, and the skill mandates the marker as the
final line of the reply — so a note appended after the report pushes the marker
out of that window and a cron that asked to stop fires forever instead. The
agent's own text must stay at the tail. This is the same failure the "read the
markers before capping" rule prevents, arriving from the other end; both are
pinned by tests.

`classifyRun` is pure, exported and tested for exactly this reason: it is shared
by all three fire paths, and two paths that classified differently would make the
same failure read differently depending on which backend happened to run it.

## Settling

The pane scrapes a spinner. Everything else answers `isWorking`, which brings the
opposite hazard: pi, omp and prime answer it with a round-trip `get_state`, and
`submit` only awaits the RPC ack — "a model turn is NOT a request; prompt acks
immediately" (`runtime/jsonl-transport.ts`). So there is a window after submit
where a perfectly healthy turn reads as idle.

Three guards, and review found the first two missing from the first attempt:

1. **Any emitted item counts as a sign of life**, not just a busy reading. The
   idle clock was originally anchored to the start of the fire and moved only on
   `isWorking`, so a turn deep in a long tool call — plainly alive, emitting tool
   traffic — was declared finished 8s after the fire *started*. The pane path
   never had this bug: every transcript line bumps `lastEventAt`.
2. **The start grace runs from after `ensure`+`submit`**, not from the top of the
   fire. `ensure` spawns a child and, for pi, reads the encrypted secret store
   through subprocesses first; on a loaded machine that used to eat tens of
   seconds out of the window meant to cover the backend's first token.
3. **`sawWorking`**: a turn we watched start is only finished once we have also
   watched it stop.

The 120s grace is generous on purpose — the two failure directions are not
symmetric. Waiting too long on a dead backend costs two minutes on a run that was
going to fail anyway; settling too early reports a *working* cron as `no_output`
and sends someone to read logs that say nothing is wrong.

## Credentials

An ordinary cron gets **no hermit tools and no machine key** — `hermitTools:
false` on the session. This is not caution in the abstract:
the hermit tools all act on `HERMIT_SESSION_ID`, and a cron's session id is a
throwaway with no `ChatSession` row behind it, so every call 404s while the
dashboard credential sits in the child and in every tool subprocess it spawns.
Useless and exposed at once. The pane path has refused this since crons existed
(`cronPaneEnv`, pinned by a test); this is what lets a cron keep that refusal
after moving off the pane. The orchestrator's crons still get both — they need
the brain tools to do their job.

`pi-rpc`, `omp-rpc` and `prime-rpc` honour the same flag, and they had to: it
would be wrong to call their behaviour pre-existing, because **before this change
no cron ever ran on pi, omp or prime at all** — they fell through the `else` onto
the pane. This change is what would first have handed them the key, so it is also
what withholds it. `dsh-exec` needs no flag (it has no hermit tool surface and
never receives the key).

**Still open:** `codex-exec` injects `HERMIT_KEY` unconditionally. That one IS
pre-existing — codex crons have run since 2026-08-15 — and is not made worse
here, but a codex cron still carries the key.

## Known gaps

- **`lastKnownUsage` grows per fire.** `claude-sdk.ts` writes an entry keyed by
  session id in `teardown` and never deletes it. For chats the key set is bounded
  by the number of sessions; every cron fire adds a permanent entry keyed by a
  throwaway `cron-<id>-<ms>`. Small, but monotonic for the life of the process.
- **claude-sdk backgrounds long commands, and `cronPrompt` asks it not to.** A
  PreToolUse hook backgrounds a known-slow command list (`npm install`, `docker
  build`, `pytest`, `cargo build`, …) before it runs, and a watchdog backgrounds
  anything past three minutes. The pane had no equivalent, so moving a cron onto
  claude-sdk re-opens the hazard `cronPrompt` exists to prevent — on exactly the
  commands a maintenance cron is most likely to run.
- **pi's boot-failure path orphans a child.** `pi-rpc`'s `boot()` spawns, then
  rethrows on a failed `client.start()` without `client.stop()`. Crons amplify
  it: the retry is now every interval, and pi's backoff is keyed by session id —
  a fresh throwaway on every fire — so the backoff never applies to a cron.
- **Failure detection matches on prose.** `isFailureNote` pattern-matches each
  backend's failure text. The right home is a typed flag on `SyncItem`, set where
  each runtime already knows the turn failed. The interim is safe because the
  note is reported either way; an unrecognised failure still reaches the reader
  as text, it just does not colour the status.

## Rollout

Safe in either order, which is worth knowing because the gateway drives every
scheduled task on the machine including the one that wakes Brain:

- **new gateway, old dashboard** — two sub-cases, and only one is a no-op. A
  *composed* backend id (`pi-kimi`) is not a harness, `runtimeFor` returns null,
  and the fire falls back to the pane exactly as before. But an old dashboard
  also stores **bare harness names** (`claude-sdk`, `pi-rpc`, `prime-rpc`,
  `dsh-exec`) as legacy values, and those DO pass `canRunCronTurn` — so the new
  gateway takes the runtime path with no credential, provider or model, and a
  bare `pi-rpc` with no mode resolves to the omp engine. It will run, but not
  necessarily as the picker says. Deploy the dashboard first, or accept that
  window.
- **old gateway, new dashboard** — the dashboard sends a harness; the old gateway
  tests only for `codex-exec` and otherwise uses the pane, exactly as before.
