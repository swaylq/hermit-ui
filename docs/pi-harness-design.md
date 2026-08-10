# Task harnesses, and a mode that picks one

Status: implemented, 2026-08-10. Follows [pi-modes-design.md](pi-modes-design.md)
and [pi-modes-more-design.md](pi-modes-more-design.md).

## Goal

The modes that existed were **role-shaped** — Writer, Consultant, Ops. A human
picks one because they know what kind of person they want. This adds
**task-shaped** ones — Answer, Scout, Patch, Shell, Web — split by *which tools
the work needs*, and then `triage`, which reads the first prompt and becomes the
cheapest of them that can finish it.

Role-shaped modes cannot be routed to, because "is this a Writer question" has
no mechanical answer. "Does this need `edit`" does.

## The measurement this rests on

Same task, same model, same correct answer, on a 15-file repo (find a constant,
report `VALUE|PATH`):

| recipe | wall clock | tokens per turn |
| --- | ---: | ---: |
| omp, everything on — the fleet default | 4,018 ms | 38,352 |
| pi, `read,grep,find,ls`, no skills | **2,132 ms** | **2,945** |

**1.9× faster, 13× cheaper.** The standing tax by recipe, measured on a trivial
prompt (`input + cacheRead + cacheWrite`, never `input` alone — the endpoint
caches the prefix and a repeated recipe otherwise measures as free):

| recipe | tokens |
| --- | ---: |
| omp, all tools | 22,099 |
| omp, `--no-tools --no-skills --no-rules --no-lsp` | 8,101 |
| pi, stock | 4,210 |
| pi, `--tools read` | 3,694 |

Read that as: **the tool schema is the tax.** Turning off skills, rules and LSP
together saves ~4%; cutting 21 tools to 4 saves ~49%. omp's floor is above every
pi harness's full price, which is why the engine is chosen by which tools the
work genuinely needs and not by preference.

## The harnesses

| mode | engine | tools | standing tax |
| --- | --- | --- | ---: |
| `answer` | pi | read | 4,752 |
| `shell` | pi | bash, read | 4,942 |
| `triage` | pi | routes, then narrows | 5,069 |
| `scout` | pi | read, grep, find, ls | 5,382 |
| `patch` | pi | + edit, write, bash | 5,883 |
| `web` | omp | web_search, read | 11,401 |

Each `SYSTEM.md` is under 1 KB and carries discipline only — site knowledge stays
in skills, as established in pi-modes-design.md.

`web` is the only one on omp, and only because `web_search` exists nowhere else.

## `triage`

A mode that reconfigures itself. It boots with the union of the pi harnesses'
tools, and on `before_agent_start`:

1. routes `event.prompt` — regex rules first (0.2 ms, free), a ~250-token call
   to a cheap model when they abstain, `omp` if both fail;
2. `pi.setActiveTools()` to the winner's set;
3. returns `{ systemPrompt: event.systemPrompt + winner's SYSTEM.md }`;
4. writes `[triage → scout · rules 0.94 — …]` into the transcript, so a bad route
   is diagnosable from the chat rather than only from the gateway log.

**Narrowing lands on the current turn, not the next.** Measured: booting with
`read,bash,edit,write` and narrowing to `[read]` cost 3,963 tokens, identical to
booting with `--tools read`. So carrying the union until it decides is free.

`web` and `omp` cannot be *become* — an extension can change tools, not engines.
They are reached through a `delegate` tool that runs one as a one-shot omp
subprocess, so the session stays at pi prices and only the delegated turn pays
omp's.

Two things that are load-bearing and non-obvious:

- **`delegate` is listed in `mode.json`'s `tools`.** pi's `--tools` allowlists
  extension tools too, so a tool that is registered but not listed cannot be
  activated later: `setActiveTools()` accepted the name silently, the model got
  "Tool delegate not found", fell back to `bash`, and — with `bash` narrowed
  away — blocked on `ask`'s 4h timeout.
- **A `web` pick narrows `bash` away.** Left with a shell, the model answered
  "搜一下最新版本号" with two `curl` calls and never touched `delegate`. A shell
  is one obvious step; a custom tool has to be understood first. Prompting
  against it is not enough — the general tool has to go.

### What `delegate` costs, and how it shows its work

First contact with a real session (2026-08-10, `asst` on mobile) produced one
opaque `→ delegate 搜索 2025 年…` row and a spinner for four minutes. Two
separate causes, both now fixed:

- **It ran on opus.** The `--model` pin was gated on `HERMIT_PI_MODEL`, a name
  the gateway never sets — it sets `HERMIT_PI_MODELS`, the plural catalogue. So
  every delegated run went out unpinned and omp resolved its own default, which
  on this fleet is `claude-opus-5`. `delegateModel()` now picks the fastest model
  the machine publishes (haiku, then sonnet, else omp's choice). Same query:
  ~4 min → 51 s.
- **Nothing streamed.** `translatePiEvent` does not translate
  `tool_execution_update`, so even pi's own `onUpdate` channel cannot reach the
  dashboard. The delegate now runs omp with `--mode json`, reads its event
  stream, and rewrites a **single live chat row** — `/api/sync/chat-message` is
  unique on `(sessionId, externalId)` and a conflict is an UPDATE that
  deliberately does not bump `lastMessageAt`, so a stable id gives a status line
  with no row spam and no unread badge.

A third thing surfaced while testing the ceiling. `omp --max-time` exits **0**,
so the exit code cannot distinguish a finished run from a guillotined one: at
`--max-time 45` the last assistant text was *"Verified OpenAI Presence
(official). Now verifying other claims against primary sources."* — a progress
sentence, 88 characters, which the parent would have read as the finding. Any
run that reaches 90% of its budget is now labelled TRUNCATED in the tool result,
with an instruction to re-delegate something narrower.

Routing accuracy on a held-out set of 30 tasks written without looking at the
rules: **83–87% exact, 90% safe** (safe = the pick could still finish the job),
~700 ms per decision, once per session. Ties resolve toward *more* capability and
the fallback is `omp`, because being wrong toward expensive is a budget line
while being wrong toward cheap is a failed turn plus a retry that pays the whole
context again.

## The Triage card

`triage` is offered on the **backend picker**, beside Claude Code and pi, rather
than as a row in the Mode dropdown. From the user's side the question that
picker asks is "who runs this", and the honest answer for triage is "it decides"
— a peer of the other two, not a variant of one. Picking it hides the Mode
select, since choosing a mode by hand is what it exists to avoid.

It is a **pseudo-kind in the UI only**. Selecting the card stores an ordinary pi
session:

```
{ runtime: 'pi-rpc', runtimeMode: 'triage' }
```

Nothing downstream knows about it — `runtimeFor()` sees `pi-rpc`, `resolveMode()`
finds `triage` on disk, `buildModeArgs()` expands it like any other mode. No
migration, no new `RuntimeKind`, no gateway change. `RUNTIME_KINDS` stays the set
of real backends and `BACKEND_OPTIONS` is what the picker renders;
`toBackendOption` / `fromBackendOption` map between them, with a test asserting
`triage` never leaks into `RUNTIME_KINDS` (a session written with
`runtime: 'triage'` would reach no gateway at all).

Setting it as an **agent's** default backend is what makes every new session on
that agent auto-route.

## Testing

- `apps/gateway/src/runtime/pi-modes.test.ts` — the on-disk recipes load; the pi
  harnesses keep hermit's tools and stay off omp; `web` gets no hermit union
  (omp's `--tools` hard-errors on non-built-ins); `triage` allowlists `delegate`
  and ships `route.mjs` beside its extension.
- `apps/dashboard/src/lib/runtime-labels.test.ts` — the card ↔ columns mapping,
  including that a stale `triage` mode on a claude session does not light the
  card.
- Gateway 245 pass, dashboard 304 pass, `next build` clean, `tsc --noEmit`
  byte-identical to the pre-change baseline.

End-to-end against a live pi child on hyqubit:

```
"RETRY_BUDGET 定义在哪个文件"   → scout   2,746 tok   (rules, free)
"用一句话解释 prompt caching"    → answer  1,922 tok   (smol)
"搜一下 oh-my-pi 最新版本号"     → web     5,755 tok   (rules → delegate → omp subprocess)
```

All three correct.

## Rollout

Existing rows are unaffected: no session or agent has `runtimeMode = 'triage'`
until someone picks the card. The five task harnesses are additive mode
directories; the six pre-existing modes are untouched.

The bench scripts and the router's eval sets live outside this repo, in the
hermit-harness agent's `projects/pi-harness/`. `route.mjs` is vendored here
beside the extension that imports it, because a mode directory that reached back
into a dev checkout at runtime would break on the machine that never had one.
