# Agent Share — Implementation Plan

> **For agentic workers:** implement task-by-task. No unit-test harness in this
> repo → verification is **typecheck** (`npx tsc --noEmit` in `apps/dashboard`),
> **`next build`**, and **runtime probes** (curl a scoped key, browser check).
> Spec: `docs/agent-share-design.md`.

**Goal:** A per-agent "Share" link that drops the holder into a dashboard scoped
to one agent (full operation of it; everything else hidden + refused at the
tRPC/HTTP/WS layer; terminal escape accepted).

**Architecture:** `AgentShareLink` table → `resolveKey` yields a scoped ctx →
`machineProcedure` denies scoped keys (default-deny for ~190 endpoints) →
`agentProcedure` re-opens the agent's own endpoints with a forced
`agentName: ctx.scopedAgent` filter → share token rides the existing
`X-Asst-Key` transport as a flagged keyring entry.

**Verification gate per task:** typecheck clean. Build gate at Tasks 5/9/10.

---

### Task 1 — Schema + migration

**Files:** `apps/dashboard/prisma/schema.prisma`, new
`apps/dashboard/prisma/migrations/<ts>_agent_share_link/migration.sql`.

- [ ] Add `model AgentShareLink` (id, machineId, agentName, keyHash, keyPrefix,
  createdAt, lastUsedAt; `@@unique([machineId, agentName])`; `@@index([keyPrefix])`;
  `machine` relation `onDelete: Cascade`).
- [ ] Add `shareLinks AgentShareLink[]` to `Machine`.
- [ ] Hand-write additive `migration.sql` (`CREATE TABLE` + indexes + FK), matching
  the existing migration dir convention.
- [ ] Verify: `npx prisma format` + `npx prisma validate` + `npx prisma generate`.

### Task 2 — `auth.ts`: scoped resolver + cache

**Files:** `apps/dashboard/src/server/auth.ts`.

- [ ] `resolveShareLinkByKey(plain)`: prefix(12) lookup on `AgentShareLink` + bcrypt;
  return `{ machine, agentName }`. Throttled `lastUsedAt` bump (reuse debounce idea).
- [ ] `resolveKey(plain)`: machine first → `{scope:'machine',machine,scopedAgent:null}`;
  else if `plain.startsWith('shr_')` → share path → `{scope:'agent',machine,scopedAgent}`;
  else null. Short (30s) cache for share resolutions; `invalidateShareCache(prefix)`.
- [ ] Verify: typecheck.

### Task 3 — `trpc.ts`: three procedures

**Files:** `apps/dashboard/src/server/trpc.ts`.

- [ ] `resolveKeyIntoCtx` middleware → injects `{ machine, scope, scopedAgent }`.
- [ ] `authedProcedure` (key valid, no restriction).
- [ ] `machineProcedure` = authedProcedure + **throw FORBIDDEN if scope==='agent'**
  (keeps name/shape → all existing routers auto-deny scoped).
- [ ] `agentProcedure` = authedProcedure exposing `ctx.scopedAgent` + helper
  `assertAgent(name)` (no-op for machine keys; FORBIDDEN if name !== scopedAgent).
- [ ] Verify: typecheck (existing routers still compile — `ctx.machine` unchanged).

### Task 4 — `share.ts` router + mount

**Files:** new `apps/dashboard/src/server/routers/share.ts`, edit
`apps/dashboard/src/server/routers/_app.ts`.

- [ ] `create`/`get`/`regenerate`/`revoke` (`machineProcedure`, owner-only): upsert by
  `(machine.id, agentName)`; `create`/`regenerate` return `{ url }` with the token ONCE;
  `get` returns `{ exists, createdAt, lastUsedAt }`; `revoke` deletes; all bust cache.
- [ ] `redeem` (`publicProcedure`, token in input) → `{ agentName, machineName }`.
- [ ] `whoami` (`authedProcedure`) → `{ scope, agentName? }`.
- [ ] Mount `share: shareRouter` in `_app.ts`.
- [ ] Verify: typecheck.

### Task 5 — Convert allowlist endpoints to `agentProcedure`

**Files:** `chat.ts`, `agents.ts`, `cron.ts`, `fileManager.ts`, `interaction.ts`.

Pattern: swap `machineProcedure` → `agentProcedure`; where the resolver filters by
`machineId: ctx.machine.id`, also constrain to the scoped agent
(`...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {})`, or force
`agentName = ctx.scopedAgent ?? input.agentName`, or `assertAgent` after loading a
session/cron/path). **Leave gateway-poll endpoints on `machineProcedure`** (deny
scoped — the browser never calls them):

- [ ] **chat.ts** convert: `listSessions, markRead, setHidden, createSession,
  closeSession, reopenSession, deleteSession, appendSystemNote, setTitle,
  listMessages, queue, loopRuns, deleteLoop, send, cancelTurn, dequeue, clearQueue`.
  **Leave on machineProcedure:** `pollPending, ackDelivered, pollCancellations,
  ackCancel, requestSessionRestart, pollSessionRestarts, ackSessionRestart`.
- [ ] **agents.ts** convert (agent-detail reads + edit): `byName, skillRefs,
  skillContents, coreTexts, folders, folderContent, requestEdit`. **Leave:** `list,
  listTrashed, requestCreate, requestImport, requestDelete, requestRestore,
  requestPurge, setOrchestrator, setupBrain, ensureBrain, pendingRequests,
  pollRequests, listForGateway, ackRequest`.
- [ ] **cron.ts** convert: `listForAgent, get, runOutput, markRunRead, create,
  update, delete, runNow, createFromSession, listForSession, deleteFromSession`
  (constrain/assert to scoped agent). **Leave:** `list, markAllRead, listForGateway`.
- [ ] **fileManager.ts** convert all (`list, readText, writeText, mkdir, remove,
  rename, prepareDownload, downloadStatus`) — assert the resolved path is under the
  scoped agent's directory.
- [ ] **interaction.ts** convert: `listPending, byId, resolve` (assert the
  interaction's agent === scoped).
- [ ] Verify: typecheck + `next build`.

### Task 6 — Non-tRPC surfaces

**Files:** `apps/dashboard/server.ts` (term WS + any stream/sync), chat SSE route.

- [ ] Terminal WS (`hermit-key.<token>`): resolve via `resolveKey`; if scoped, allow
  only when the session's agent === scopedAgent, else reject upgrade.
- [ ] Chat SSE stream: same agent check.
- [ ] Gateway WS + `/api/sync/*`: **reject scoped keys** (machine-only).
- [ ] Verify: typecheck.

### Task 7 — Client: keyring flag + landing route

**Files:** `apps/dashboard/src/lib/keyring.ts`, new
`apps/dashboard/src/app/s/[token]/page.tsx`.

- [ ] `KeyringEntry` += `scoped?: boolean; agentName?: string`.
- [ ] `/s/[token]`: `share.redeem` → add scoped entry + setActive → `replaceState`
  to strip token → `window.location.href` to `/chat?agent=<name>` (Next16: hard nav,
  not router — see `hermit-ui-router-nav-callback`).
- [ ] Verify: build.

### Task 8 — Scoped shell + guards

**Files:** new `apps/dashboard/src/lib/use-scope.ts` (or a context), edit
`apps/dashboard/src/components/app-sidebar.tsx`, a route guard.

- [ ] `useScope()` from `share.whoami` → `{ scope, agentName? }`.
- [ ] Sidebar: when scoped, hide NAV pills, Brain/Market header icons + mode
  switches, `WorkspaceSwitcher`; `RecentAgents`/`RecentSessions` show only the agent.
- [ ] Guard: scoped users on `/agents`(list)`/cron`/`/skills`/`/brain`/`/market`/
  `/global-memory` → redirect to `/chat?agent=<scopedAgent>`.
- [ ] Verify: build.

### Task 9 — Share button + dialog

**Files:** `apps/dashboard/src/app/agents/page.tsx`, new
`apps/dashboard/src/components/share-agent-dialog.tsx`.

- [ ] Button in `AgentMain` header (top-right, before Chat; `Share2` pill); rendered
  only when `scope==='machine'`. Hide Delete (and Share) when scoped.
- [ ] Dialog via `components/overlay.tsx`: `share.get` state → Generate / show URL
  once / Regenerate / Revoke; copy via `navigator.clipboard` + "✓ copied".
- [ ] Verify: build.

### Task 10 — Full verify

- [ ] `apps/dashboard` typecheck clean + `next build` clean.
- [ ] (post-deploy) Runtime probes: owner mints link; second browser profile opens
  `/s/<token>` → lands scoped, can chat/files the agent; `machines.list` /
  `agents.list` with the scoped key → 403; another agent's `chat.listSessions` → 403.

### Task 11 — Deploy

- [ ] `git fetch origin main`; rebase `feat/agent-share` onto `origin/main` if moved.
- [ ] Merge → `main`, `git push origin main` → VPS `scripts/vps-deploy.sh`
  (`prisma migrate deploy` + `next build` + restart).
- [ ] Confirm migration applied + dashboard back up; run Task 10 runtime probes.
