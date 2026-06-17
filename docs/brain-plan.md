# 义脑 / Brain — Phase 1 Implementation Plan

> Spec: `docs/brain-design.md`. Phase 1 = human → brain → dispatch + report +
> digest. No unit-test harness in this repo → each step verified with
> typecheck + `next build` + (for the gateway) `tsc --noEmit` + on-device runtime.

**What shipped:** `Agent.isOrchestrator` + a `setupBrain` flow + a gated group of
cross-agent MCP tools (`roster` / `agent_activity` / `dispatch` / `dispatch_result`)
that wrap existing machine-scoped tRPC, + the sidebar crab button wired to open
(or set up) the orchestrator's chat. The brain's directive lives in its IDENTITY.

---

## Task 1 — Schema: `Agent.isOrchestrator`
- `apps/dashboard/prisma/schema.prisma` — `isOrchestrator Boolean @default(false)`.
- `apps/dashboard/prisma/migrations/20260617120000_agent_is_orchestrator/migration.sql`
  — `ALTER TABLE "Agent" ADD COLUMN "isOrchestrator" BOOLEAN NOT NULL DEFAULT false;`
- `prisma generate`; `tsc --noEmit` ✓

## Task 2 — Agents router
- `apps/dashboard/src/server/routers/agents.ts`:
  - expose `isOrchestrator` in `list`, `byName`, `listForGateway` selects;
  - `setOrchestrator({name, value})` mutation — single-orchestrator invariant
    (clears any other on the machine);
  - `setupBrain()` mutation — scaffold a dedicated `brain` agent with the
    orchestrator IDENTITY overlaid (`brain-template.ts`) + flag it.
- `apps/dashboard/src/server/brain-template.ts` — `BRAIN_PERSONA` + `BRAIN_IDENTITY`.

## Task 3 — Gateway gating (`HERMIT_BRAIN`)
- `apps/dashboard/src/server/routers/chat.ts` — `pollPending` carries
  `isOrchestrator` per session.
- `apps/gateway/src/api.ts` — `pollChatPending` type carries `isOrchestrator?`.
- `apps/gateway/src/chat-runner.ts` — `buildMcpConfigArg(sessionId, isBrain)` sets
  `HERMIT_BRAIN=1` in the stub env for orchestrator sessions; `PendingSession`
  type + the call site pass `session.isOrchestrator`.
- `tsc --noEmit` (gateway + dashboard) ✓

## Task 4 — Brain-only MCP tools (`apps/gateway/src/mcp-stub.cjs`)
- `const BRAIN = process.env.HERMIT_BRAIN === '1'` gate + a `textOf()` helper.
- `BRAIN_TOOLS` (`roster` / `agent_activity` / `dispatch` / `dispatch_result`) wrap
  existing machine-scoped tRPC (`agents.list` / `agents.byName` /
  `chat.createSession` / `chat.send` / `chat.listSessions` / `chat.listMessages` /
  `cron.create` / `cron.listForAgent`) using the stub's in-process `HERMIT_KEY`.
- `tools/list` returns them only when `BRAIN`; `dispatchTool` rejects them unless
  `BRAIN`. `dispatch` validates the target (real, non-trashed, non-self).
- `node --check` ✓

## Task 5 — Brain identity (orchestrator directive)
- `brain-template.ts` `BRAIN_IDENTITY`: prime directive (never do work yourself),
  the tool playbook (roster → agent_activity → dispatch → dispatch_result), the
  memory convention (`memory/agents/<name>.md` dossiers + daily log + dispatch
  ledger), and the self-scheduled incremental digest (via the `cron` skill).
- Delivered by `setupBrain` as a `templateFiles` overlay onto `IDENTITY.md` at
  scaffold time (keeps the base `AGENTS.md` rules + default skills incl. `cron`).

## Task 6 — UI
- `apps/dashboard/src/components/app-sidebar.tsx` — `BrainButton`: opens the
  orchestrator's most-recent open chat (or starts one); if no orchestrator exists,
  one click runs `setupBrain` and lands on the scaffolding `brain` agent.
- `apps/dashboard/src/components/agent-detail-sheet.tsx` — `OrchestratorToggle`:
  promote / demote any agent as 义脑 (flag-only).
- `tsc --noEmit` + `next build` ✓

## Deploy
- Dashboard: `git push` → VPS `scripts/vps-deploy.sh` (prisma migrate deploy +
  next build + pm2 restart; health 200).
- Gateway (Mac, pm2): restarted so the new `chat-runner` / `api` / `mcp-stub.cjs`
  take effect — new sessions get the gated tools; existing ones inherit on their
  next restart.

## Phase-1 runtime acceptance (on the dashboard)
1. Click the sidebar crab → "set up 义脑" → a `brain` agent scaffolds + opens.
2. In the brain's chat, give it a goal → it `roster()`s, `dispatch`es to an agent,
   reports what it handed off.
3. The target agent's session shows the dispatched task; `dispatch_result` reads
   it back.
4. The brain's digest cron writes `memory/agents/<name>.md` + a daily log.

## Phase 2 (deferred)
Autonomous oversight loop (brain self-dispatches), a dedicated Brain panel +
`Dispatch` table, and sub-agent→brain completion notifications. The Phase-1 tools
are additive-ready for it.
