# 义脑 / Brain — Orchestrator Agent Design

**Goal:** A per-machine orchestrator agent ("义脑" / brain) that does no work
itself. It routes every task to the right sub-agent on the same machine, and
periodically digests what those agents have done into its own memory.

**Architecture:** A normal hermit agent flagged `isOrchestrator`, given a small
set of *brain-only* MCP tools (gated by a `HERMIT_BRAIN=1` env on its sessions)
that wrap the **already-existing**, machine-scoped tRPC procedures for dispatch +
observation. A digest cron consolidates agent activity into the brain's memory.
Entry point is the sidebar crab button → a chat with the brain agent.

**Tech stack:** Next.js 16 App Router + tRPC + Prisma/Postgres (dashboard);
Node+tsx gateway (`chat-runner.ts`, `cron-runner.ts`, `mcp-stub.cjs`); Claude
Code per-agent runtime in tmux.

**Scope:** Phase 1 = **A** (human → brain → dispatch + report; plus the digest).
Phase 2 (deferred, see §6): autonomous management + a dedicated Brain panel.

---

## 1. Background — why this is mostly a thin layer

Two facts (verified by reading the codebase) make the backend nearly free:

1. **Dispatch + observation already exist as machine-scoped tRPC.** A machine key
   (`X-Asst-Key`) can read/write *every* agent/session/cron on that machine —
   there is no per-agent auth and no "browser-user vs agent" distinction
   (`machineProcedure`, `apps/dashboard/src/server/trpc.ts:24-29`). The brain is
   just a machine client.

2. **The MCP stub already holds the machine key.** `apps/gateway/src/mcp-stub.cjs`
   runs as a per-session stdio child of `claude --mcp-config`, with `HERMIT_KEY`,
   `HERMIT_DASHBOARD_URL`, `HERMIT_SESSION_ID` in its env
   (`apps/gateway/src/chat-runner.ts:46-66, 691-703`). The agent never touches the
   key — it calls tools; the stub calls tRPC. So new capabilities belong here, as
   tools.

The **only** missing piece is agent→agent reach: every current MCP tool is
"manage only myself" (`cron_create` schedules a cron for *this* agent, etc.).
There is **no** tool today to message another agent or read another agent's
activity. We add exactly that, as a **gated** tool group.

### Reused tRPC procedures (no new endpoints for Phase 1)

| Need | Procedure | File:line |
| --- | --- | --- |
| List agents + counts | `agents.list` | `routers/agents.ts:16-48` |
| One agent's capabilities/memory | `agents.byName` | `routers/agents.ts:59-87` |
| One-shot dispatch: new session | `chat.createSession` | `routers/chat.ts:110-116` |
| One-shot dispatch: send prompt | `chat.send` | `routers/chat.ts:285-372` |
| Recurring dispatch | `cron.create` | `routers/cron.ts:102-107` |
| Who's busy / last turn | `chat.listSessions` | `routers/chat.ts:43-93` |
| Read an agent's output | `chat.listMessages` | `routers/chat.ts:177-203` |
| Cron execution history | `cron.get` | `routers/cron.ts:64-73` |
| (block check) pending prompts | `interaction.listPending` | `routers/interaction.ts:25-32` |

All are `machineProcedure` → authorized by the same `HERMIT_KEY` the stub already
has.

---

## 2. Components

### 2.1 The brain agent — `Agent.isOrchestrator`

- **Schema (additive):** add to `Agent` (`apps/dashboard/prisma/schema.prisma:321`)
  ```prisma
  isOrchestrator Boolean @default(false)
  ```
  Hand-written additive migration (`ALTER TABLE "Agent" ADD COLUMN "isOrchestrator" BOOLEAN NOT NULL DEFAULT false;`). No backfill needed.

- **At most one orchestrator per machine** — enforced at the app level in the
  set-mutation (promoting one clears the flag on any other on that machine).
  Postgres has no conditional unique for "one true per machineId" without a
  partial index; app-level enforcement is simpler and sufficient.

- **Persona:** the brain's `IDENTITY.md` / `AGENTS.md` encode the prime directive
  — *never do a task yourself; decompose the goal, pick the agent(s) by
  capability, dispatch, monitor, report* — plus how to drive the brain tools and
  maintain its roster/digest memory.

- **Creation (Phase 1):** a "Set up 义脑" flow that either (a) **promotes** an
  existing agent (sets the flag, overlays the brain persona/skill) or (b)
  **scaffolds** a dedicated agent from a built-in `brain` template
  (`apps/cli/template/` + `agent-lifecycle.ts` scaffold path) and sets the flag.
  Recommended default: scaffold a dedicated `brain` agent so a normal agent isn't
  repurposed. Exact UX detailed in the plan.

- **Surfaced** in `agents.list` / `agents.byName` and, crucially, in
  `agents.listForGateway` so the gateway can gate the tools (§2.2). Add a
  `setOrchestrator(name, value)` mutation to the agents router (clears others on
  the machine).

### 2.2 Brain-only MCP tools — `apps/gateway/src/mcp-stub.cjs`

**Gating.** `chat-runner.ts` already builds the MCP config per session
(`buildMcpConfigArg`, `:46-66`). It learns each session's agent from
`chat.pollPending` (`routers/chat.ts:423-461`). We extend the gateway's view of
an agent with `isOrchestrator` (via `agents.listForGateway`) and, when the
session's agent is the orchestrator, set `HERMIT_BRAIN=1` in the stub env. The
stub registers the tool group below **only when `HERMIT_BRAIN=1`** — so a normal
agent can never dispatch to others.

**Tools** (each calls an existing machine-scoped tRPC via the in-stub
`HERMIT_KEY`; the brain never sees the key):

- **`roster()`** → `agents.list` + per-agent capability summary from
  `agents.byName` (identity + skillNames + memorySummary). Excludes the brain
  itself and trashed agents. → the routing table.

- **`agent_activity(name, sinceISO?)`** → `chat.listSessions({agentName})` +
  recent `chat.listMessages` for the live/recent sessions + `cron.get` for that
  agent's crons. Returns a compact "what did agent X do (since T)" digest
  (last prompts/replies, run statuses), not full transcripts.

- **`dispatch(agentName, prompt, opts?)`** →
  - one-shot (default): `chat.createSession({agentName, title})` then
    `chat.send({sessionId, text: prompt})`. Returns `{ sessionId }`.
  - recurring (`opts.recurring = {intervalMinutes, jitterMinutes?}`):
    `cron.create({agentName, prompt, intervalSec, jitterSec})`. Returns
    `{ cronId }`.

- **`dispatch_result(sessionId, opts?)`** → newest `chat.listMessages`; optional
  short bounded poll (`opts.waitMs`, capped well under the stub's 4h ASK ceiling)
  to grab a result that just landed. For reading back a one-shot dispatch.

- *(optional, low priority)* **`agent_blocked(sessionId)`** →
  `interaction.listPending` so the brain can report "agent X is waiting on a
  permission/question". Auto-resolving blocks is **out of scope** for Phase 1.

### 2.3 Digest cron + memory convention

- The brain owns a **digest cron** (default every 30–60 min) created through the
  existing cron path (it is itself a normal cron on the brain agent).
- Each run executes the brain's digest prompt, which:
  1. `roster()` to refresh the agent list,
  2. `agent_activity(each, since=lastDigestAt)` to pull **incremental** activity,
  3. writes the digest into the brain's own memory:
     - `memory/agents/<name>.md` — a rolling per-agent dossier (what it does, recent work, quirks),
     - `memory/<date>.md` — the day's machine-wide log,
     - updates `MEMORY.md` index,
     - records dispatched tasks + their status in `memory/dispatch-log.md`,
     - stamps `lastDigestAt` (in `memory/` so the next run is incremental).
- **Incremental, not a per-tick full scan** (honors the project rule against
  per-tick full-table sweeps): each run only reads activity since the last digest.

### 2.4 UI — crab button → brain chat

- `BrainButton` (`apps/dashboard/src/components/app-sidebar.tsx`) changes from the
  "coming soon" placeholder to:
  - if the active machine has an `isOrchestrator` agent → open (or create) a chat
    session with it (navigate to `/chat?session=…`, or create-then-navigate, using
    the existing chat flow),
  - if none exists → a small "Set up 义脑" entry that runs the promote/scaffold
    flow (§2.1).
- **Phase 2** (deferred): a dedicated **Brain panel** — roster + each agent's
  latest digest + a dispatch console + outstanding-task list. That view is what
  would justify a `Dispatch` DB table; **Phase 1 keeps the dispatch ledger in the
  brain's memory** (zero schema beyond `isOrchestrator`).

---

## 3. Data flow + async semantics

```
You ──chat──▶ 义脑 agent ──dispatch──▶ chat.send / cron.create ──▶ target agent session
                  ▲                                                       │
                  └── agent_activity ◀── chat.listMessages / cron.get ◀────┘
                  └── digest cron ──▶ brain memory (roster dossiers + daily log)
```

**Dispatch is asynchronous.** `dispatch` queues a message; the target agent runs
on its own turn (gateway `chat.pollPending` → tmux). The brain cannot
synchronously block for the result inside one turn in a clean way, so the v1 UX is:
the brain replies *"dispatched to X"*, then reads the result back later via
`dispatch_result` (next turn) or surfaces it in the next digest.

**Phase 2 — reactive dispatch loop (built 2026-07-09).** The pull-only v1 had two
failure modes: a dispatched agent that BLOCKS on a choice (permission / question)
stalls invisibly — the brain, waking only on its daily dream, never learns it's
parked — and a dispatched agent that FINISHES is never advanced until the brain
happens to poll. Both are now closed:
- `dispatch_result` / `dispatch_list` surface each dispatch's real state: `working`
  (from the pane's `state`, not just process-alive), and `blocked` (its oldest
  pending `Interaction`, shaped with the exact answer call).
- New brain tool **`dispatch_answer(sessionId, …)`** resolves a block — `approve`
  for a permission, `answer` for a question — via `interaction.resolve`.
- A gateway **dispatch-watcher** tick (`chat.runDispatchWatch`, ~30 s) computes a
  per-dispatch signature (`blocked:<id>` | `done:<msgId>` | `working` | …) and, on a
  transition into blocked/finished, drops a self-describing `[dispatch update]` user
  message into the brain's OWN chat session (routed via new
  `ChatSession.dispatchedBySessionId`; deduped via `ChatSession.dispatchNotify`, one
  poke per transition). The brain reacts the moment a dispatch needs it — no polling.
- The **safety rule** (taught in the new `dispatching` brain skill + inlined in every
  poke): the brain answers ONLY safe, obvious choices; anything destructive,
  irreversible, spending money, touching infra/credentials, or uncertain is escalated
  to the human, never auto-approved.

**Persona & decision style (built 2026-07-09).** An editable doc that shapes *how* the
brain dispatches and *how* it helps a blocked agent decide — a character sheet, not new
plumbing.
- **Storage:** `PERSONA.md` in the brain's working dir (native, like `IDENTITY.md` /
  `memory/`). Edited from the dashboard **Brain → Persona** tab (`/brain/persona`), a
  textarea over the existing `fileManager.readText` / `writeText` bridge — no new
  backend. Also visible under Files.
- **Seeding:** a sensible default is laid down **write-once** — on create, and once onto
  existing brains via the version-bump overlay. The gateway's `overlayTemplate` gained a
  `writeOnce` flag (skip if the file exists) + `PERSONA.md` in its allow-list, so a
  later re-overlay never clobbers the user's edits. (`BRAIN_SEED_FILES` /
  `BRAIN_OVERLAY_FILES` in `brain-template.ts`; `BRAIN_TEMPLATE_VERSION` 4→5.)
- **Injection:** the `dispatching` skill (reaches all brains) + IDENTITY (new brains)
  both tell the brain to read `PERSONA.md` and apply it when dispatching / answering.
- **Safety interaction (hard invariant):** the persona tunes voice + risk posture
  **within** the safety floor only. It can make the brain *more* cautious, never less —
  no `PERSONA.md` wording relaxes the "escalate destructive / irreversible / costly /
  outward / uncertain" floor. This is stated in both the persona section and the safety
  section of the `dispatching` skill, and in the seed doc itself.

---

## 4. Security / gating

- `HERMIT_KEY` never leaves the stub; brain tools expose only high-level verbs.
- Brain tools are gated to `isOrchestrator` sessions via `HERMIT_BRAIN=1`; no other
  agent can dispatch or read cross-agent activity.
- The brain is scoped to its **own machine** (its machine key); it cannot reach
  agents on other machines.
- The brain excludes **itself** from `roster()` targets → no self-dispatch loops,
  and the digest skips its own sessions.

---

## 5. Files to touch (Phase 1)

| Area | File | Change |
| --- | --- | --- |
| Schema | `apps/dashboard/prisma/schema.prisma` | add `Agent.isOrchestrator`; hand-written additive migration |
| Agents API | `apps/dashboard/src/server/routers/agents.ts` | expose `isOrchestrator` in `list`/`byName`/`listForGateway`; add `setOrchestrator` mutation (clears others on machine) |
| Gateway gate | `apps/gateway/src/chat-runner.ts` | read `isOrchestrator` from the gateway agent list; set `HERMIT_BRAIN=1` in the stub env for the brain's sessions |
| Gateway API view | `apps/gateway/src/api.ts` | carry `isOrchestrator` through `listForGateway`/`pollPending` |
| Brain tools | `apps/gateway/src/mcp-stub.cjs` | register `roster` / `agent_activity` / `dispatch` / `dispatch_result` (+ optional `agent_blocked`) when `HERMIT_BRAIN=1` |
| Brain persona | `apps/cli/template/` (new `brain` template) or an overlay | IDENTITY/AGENTS prime directive + tool usage + digest convention |
| Setup + UI | `apps/dashboard/src/components/app-sidebar.tsx` (+ a setup view) | `BrainButton` → brain chat, or "Set up 义脑" when none exists |
| Digest | (seeded by the brain via the cron flow, or by the setup step) | the brain's digest cron + memory layout |

No new dashboard tRPC procedures are required for dispatch/observe — only the
small `isOrchestrator` plumbing + `setOrchestrator`.

---

## 6. Phasing

- **Phase 1 (this spec) — "A":** human → brain → dispatch + report; the digest
  loop; crab-button → brain chat. The brain is human-driven, so dispatch volume is
  naturally bounded.
- **Phase 2 (later) — "B" + panel:** an autonomous oversight loop (the brain
  notices idle/stuck/should-do-X agents and dispatches on its own); a dedicated
  Brain dashboard panel; a `Dispatch` DB table backing it; sub-agent→brain
  completion notifications for synchronous-feeling replies. The Phase 1 tool group
  is designed so Phase 2 is additive (the autonomous loop reuses `roster` /
  `agent_activity` / `dispatch`).

---

## 7. Open questions / risks

- **One-orchestrator enforcement** is app-level (set-mutation clears others); fine
  for a single human operator per machine.
- **Initial brain creation** (promote existing vs scaffold dedicated) — default to
  scaffolding a dedicated `brain` agent; finalize the UX in the plan.
- **Async result readback** — acceptable for v1 ("dispatched … will report"); the
  synchronous path is Phase 2.
- **Cost/tokens** — the digest cron runs the brain on a schedule; keep it
  incremental + cap how much activity it pulls per run.
- **Dispatch storms** — not a Phase 1 concern (human-driven); becomes a real
  guardrail in Phase 2's autonomous loop.

---

## 8. Verification

No unit-test harness in this repo → verify with **typecheck + `next build` +
runtime**:

- `npm run typecheck` and `npm run build` in `apps/dashboard` after the schema +
  router + UI changes.
- Gateway changes (`mcp-stub.cjs`, `chat-runner.ts`, `api.ts`) require the **Mac
  gateway restart** (pm2) to take effect — gateway is not on the VPS.
- Runtime acceptance: create/flag a `brain` agent → open its chat from the crab
  button → `dispatch` a task to a test agent → confirm it lands in that agent's
  session → `dispatch_result` reads it back → one digest run writes
  `memory/agents/<name>.md` + the daily log.

**Deploy:** dashboard via `git push` → VPS `scripts/vps-deploy.sh` (prisma migrate
deploy + next build + pm2 restart). Gateway via the Mac pm2 (`apps/gateway`),
restarted after the `mcp-stub.cjs` / `chat-runner.ts` changes.
