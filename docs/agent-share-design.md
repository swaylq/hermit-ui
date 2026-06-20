# Agent Share — Per-Agent Scoped Access Design

**Goal:** A "Share" button on an agent that mints a per-agent link. Whoever
opens the link enters the dashboard scoped to **only that one agent**: full
operation of that agent (chat, files, detail, loop/cron, terminal), with every
other agent and all machine-global management (Brain, Market, Global Memory,
Secrets, Settings, the machine switcher) hidden and — at the tRPC/HTTP/WS layer —
refused.

**Architecture:** A new `AgentShareLink` table holds a bcrypt-hashed share token
per agent. The existing key resolver learns to recognize share tokens and yields
a **scoped** auth context. `machineProcedure` is flipped to **reject scoped keys**
(so all ~190 existing endpoints become deny-by-default for share links with zero
per-endpoint edits); a new `agentProcedure` re-opens exactly the agent-scoped
endpoints a share user needs, enforcing `target === ctx.scopedAgent`. The share
token rides the **existing** `X-Asst-Key` transport as a flagged keyring entry,
so there is no new transport. A `whoami` query tells the client to render a
stripped shell.

**Tech stack:** Next.js 16 App Router + tRPC + Prisma/Postgres (dashboard, runs
on the VPS); Node+tsx custom server (`server.ts`) for the SSE stream + term WS.
Share-link auth is **entirely dashboard-side** — bcrypt against the VPS Postgres,
resolved on the VPS, **no gateway round-trip** (unlike `secrets`, which needs the
Mac Keychain). The gateway only supplies the pty/stream *after* the VPS has
authorized. Deploy = `git push` → VPS `scripts/vps-deploy.sh` (`prisma migrate
deploy` + `next build` + restart).

**Security posture (explicit, agreed with the user):** isolation is a real
boundary on the tRPC/HTTP/WS surface, but the **terminal is an accepted
escape**. The browser terminal is `tmux attach` / node-pty to a real shell on
the host; a share user with terminal can `cd ../other-agent`, read other files,
or run `secret get` (the shell runs as the host user, Keychain auto-reachable).
We restrict *which* terminal session a share key may attach to, but cannot
sandbox the shell itself. The user has accepted this — the share is for a
**trusted recipient**; "other agents/global hidden" is a UI/API guarantee, not a
shell-level one.

---

## 1. Background — the current auth model (verified)

| Fact | Where |
| --- | --- |
| One bcrypt key **per machine** (`keyHash` + `keyPrefix` = first 8 chars, indexed). | `prisma/schema.prisma` `Machine` (~17-44) |
| `resolveMachineByKey(plain)`: prefix lookup → bcrypt compare, 5-min process-local cache. Used by tRPC **and** non-tRPC routes. | `src/server/auth.ts:44-67` |
| tRPC context reads `X-Asst-Key` header → `ctx.keyPlain`. | `src/server/trpc.ts:6-9` |
| `machineProcedure`: `keyPlain` → `resolveMachineByKey` → injects `ctx.machine`. Every router filters by `ctx.machine.id`. | `src/server/trpc.ts:24-29` |
| Browser stores keys in a **localStorage keyring** (`asst-dashboard-keyring`, `KeyringEntry[] = {id,name,key,hostname,alias}`); active machine in `sessionStorage`. | `src/lib/keyring.ts:15-30` |
| tRPC client attaches `x-asst-key: getActiveKey()` on every request. | `src/app/providers.tsx:33` |
| Browser terminal WS authenticates via `Sec-WebSocket-Protocol: hermit-key.<token>` (kept out of access logs); same `resolveMachineByKey`. | `server.ts:208-214, 304-341` |
| **No** per-agent scoping, scoped session, or RBAC today. Possess key ⇒ full access to that machine. | — |

**Consequence for this feature:** there is no boundary to hide behind, so the
boundary must be built — and the cheapest *safe* way is to make existing
endpoints deny share keys by default rather than to teach 190 endpoints to scope
themselves (miss one ⇒ leak).

---

## 2. Data model — `AgentShareLink` (additive)

`prisma/schema.prisma`:

```prisma
model AgentShareLink {
  id         String    @id @default(cuid())
  machineId  String
  agentName  String
  keyHash    String    // bcrypt(token)
  keyPrefix  String    // first 12 chars of token, indexed (prefix-filtered lookup)
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?

  machine    Machine   @relation(fields: [machineId], references: [id], onDelete: Cascade)

  @@unique([machineId, agentName])   // one active link per agent; regenerate updates in place
  @@index([keyPrefix])
}
```

Add the back-relation on `Machine`: `shareLinks AgentShareLink[]`.

- **Token:** `shr_` + 32 url-safe random chars (`crypto.randomBytes`). Stored as
  bcrypt + a 12-char prefix (`shr_` + 8 random — enough entropy for the prefix
  index). **Plaintext shown once**, at generate time, exactly like a machine key.
- **Agent identity** is `(machineId, agentName)` to match how the rest of the
  codebase references agents (chat/cron use `agentName`, not `Agent.id`).
- **Migration:** hand-written additive SQL (`CREATE TABLE` + index), matching the
  marketplace/brain migration convention. No backfill.

> **Alternative rejected:** a `scopedAgentName` column on `Machine`. A `Machine`
> row is a *workspace credential* (carries limits, `lastSeen`, hostname); a
> machine hosts many agents ⇒ many share links. The cardinality is a table.

---

## 3. Server — default-deny + a narrow allowlist

### 3.1 Combined resolver

Extend `src/server/auth.ts` with `resolveKey(plain)` that returns a discriminated
union (keeps `resolveMachineByKey` as-is for callers that only want machines):

```ts
type Resolved =
  | { scope: 'machine'; machine: MachineRow; scopedAgent: null }
  | { scope: 'agent';   machine: MachineRow; scopedAgent: string };

async function resolveKey(plain): Promise<Resolved | null> {
  const m = await resolveMachineByKey(plain);            // existing path first
  if (m) return { scope: 'machine', machine: m, scopedAgent: null };
  if (!plain.startsWith('shr_')) return null;            // fast reject non-share
  const link = await resolveShareLinkByKey(plain);       // prefix + bcrypt, like machines
  if (!link) return null;
  // throttled lastUsedAt bump (only if >60s stale) — avoids a write per request
  return { scope: 'agent', machine: link.machine, scopedAgent: link.agentName };
}
```

Share-token resolutions are cached with a **short TTL (30s)** — not 5min — and
the cache is **evicted by prefix on revoke/regenerate** so a killed link dies in
≤30s (instantly on the owner's machine, which holds the cache).

### 3.2 Three procedures in `src/server/trpc.ts`

```ts
// validates key (machine OR share), injects { machine, scope, scopedAgent }. No restriction.
authedProcedure  = t.procedure.use(resolveKeyIntoCtx)

// full-access: REJECTS share keys → all existing routers using this auto-deny scoped.
machineProcedure = authedProcedure.use(({ctx,next}) => {
  if (ctx.scope === 'agent') throw FORBIDDEN('agent-scoped key');
  return next({ ctx });
})

// agent-scoped: accepts both; if scoped, the targeted agent MUST equal ctx.scopedAgent.
agentProcedure   = authedProcedure.use(/* see 3.3 */)
```

`machineProcedure` keeps the **same name and shape**, so the ~190 call sites are
untouched — they simply gain "reject scoped" for free. `authedProcedure` is used
only by `whoami` (and any genuinely scope-agnostic read).

### 3.3 `agentProcedure` enforcement

The targeted agent comes from the call. Two shapes:
- Inputs that name the agent (`agentName` / `name`): assert it in middleware.
- Inputs that name a *session*: load the session, assert `session.agentName ===
  ctx.scopedAgent` inside the resolver (helper `assertAgentAllowed(ctx, name)`).

```ts
function assertAgentAllowed(ctx, agentName: string) {
  if (ctx.scope === 'agent' && agentName !== ctx.scopedAgent)
    throw FORBIDDEN('outside shared agent');
}
```
For machine keys `assertAgentAllowed` is a no-op (full access preserved). For
list endpoints, a scoped key **forces** the filter to `ctx.scopedAgent` (it
cannot widen).

### 3.4 Allowlist — endpoints converted to `agentProcedure`

Everything the "full operation on this agent" surface needs, and nothing else:

| Router | Procedures | Scoped rule |
| --- | --- | --- |
| `chat.ts` | `listSessions`, `listMessages`, `createSession`, `send`, `setTitle`, `deleteSession`, queue ops, interaction `respond`/`listPending` | filter / assert to `scopedAgent`; session-keyed ops verify `session.agentName` |
| `agents.ts` | `byName` (detail), config edits (`identityText`/`userText`/`agentsText`/`toolsText`/`skills`/memory), file-manager ops (list/read/write/upload/download — rooted at the agent dir) | assert `name === scopedAgent` |
| `cron.ts` | `get`, `create`, `update`, `delete`, `list` for this agent | filter / assert to `scopedAgent` |
| `loop` state (wherever read/written) | the agent's `.loop-state.json` | assert to `scopedAgent` |

**Stays on `machineProcedure` (⇒ 403 for share keys):** `machines.*`,
`agents.list`/`create`/`import`/`delete`, `brain.*`, `market.*`, `globalMemory.*`,
`secrets.*`, `skills`/settings, fleet-wide cron list. Default-deny covers these
with no edits.

### 3.5 Non-tRPC surfaces (must be gated explicitly)

Default-deny only protects tRPC. Each key-authenticated non-tRPC surface needs an
explicit rule (all call `resolveMachineByKey` today → switch to `resolveKey`):

| Surface | File | Scoped-key rule |
| --- | --- | --- |
| Browser terminal WS (`hermit-key.<token>`) | `server.ts:304-341` | accept **only** if the session's agent === `scopedAgent`; else reject upgrade |
| Chat SSE stream (`/api/chat/stream`) | stream route | same — stream only the scoped agent's session |
| Gateway WS (`/api/gateway/ws`) + sync route | `server.ts` / sync | **machine-only**: reject scoped keys outright |
| File upload/download HTTP routes (if any) | route handlers | gate to `scopedAgent`'s directory |

> The terminal rule restricts *attach target*; it does **not** sandbox the shell
> (see security posture). The SSE/WS/sync rules are hard boundaries.

---

## 4. Client — scoped shell

### 4.1 Keyring entry gains a scope flag

`src/lib/keyring.ts` `KeyringEntry`: add `scoped?: boolean` and `agentName?:
string`. A scoped entry's `key` is the `shr_…` token; it flows through the
existing `x-asst-key` header (`providers.tsx:33`) **unchanged**. The workspace
switcher labels it e.g. `agent-name (shared)`.

### 4.2 Landing route `app/s/[token]/page.tsx`

1. Call `share.redeem(token)` (publicProcedure → `{ agentName, machineName }`;
   validates the token, exposes nothing else).
2. Insert/replace a scoped keyring entry, set it active.
3. `history.replaceState` to strip the token from the URL (don't leave it in
   history/proxy logs).
4. Redirect to `/chat?agent=<agentName>` (full reload so all requests use the new
   active key — same mechanism as machine switching).

### 4.3 `whoami` + scope context

`share.whoami` (`authedProcedure`) → `{ scope, agentName? }`. A `useScope()`
context (read once near the root) drives the shell. The client trusts `whoami`
(server truth), not just the localStorage flag.

### 4.4 What the scoped shell hides

`components/app-sidebar.tsx` — when `scope === 'agent'`:
- Hide primary NAV pills (`NAV` 647-674: Chat/Agents/Cron/Settings).
- Hide the header Brain (crab) + Market icons (489-572) and the
  Dashboard⇄Market/Brain mode switches.
- Hide `WorkspaceSwitcher` in the footer (689-691) — a share user has no other
  workspace.
- `RecentAgents` (736-861): show **only** the shared agent (no New-Agent button,
  no search); `RecentSessions` shows only this agent's sessions.

`app/agents/page.tsx` `AgentMain` — when scoped: hide the **Share** and
**Delete** buttons (a share user can neither re-share nor delete). Keep the
Chat / Files tabs, terminal, loop/cron.

**Route guards:** scoped users hitting `/agents` (list), `/cron`, `/skills`,
`/brain`, `/market`, `/global-memory` are redirected to their agent. (The server
already 403s these — the guard is UX, not the boundary.)

---

## 5. Share button + dialog (owner only)

- **Button:** in `AgentMain`'s header, top-right, **before** the Chat link
  (`agents/page.tsx:120`), same pill style (`h-7 px-2.5`, `Share2` icon). Rendered
  **only** for machine keys (`scope === 'machine'`).
- **Dialog:** `components/overlay.tsx` (the repo's `createPortal` overlay — **not**
  base-ui Dialog). Contents:
  - On open, `share.get` → does a link exist?
    - **No link:** a "Generate share link" button → `share.create` → shows the
      full `https://dash.swaylab.ai/s/<token>` once.
    - **Link exists:** "A share link is active." + **Regenerate** (new token,
      old link dies) and **Revoke** (delete). The old token is not re-shown (only
      its hash is stored) — Regenerate to get a fresh copyable link.
  - Copy: `navigator.clipboard.writeText()` + "✓ copied" (the `markdown.tsx:97-107`
    pattern).

`share.ts` router (new, mounted in `_app.ts`):
| Procedure | Proc type | Returns |
| --- | --- | --- |
| `create` | `machineProcedure` | `{ url }` (token once) — upsert by `(machine, agentName)` |
| `get` | `machineProcedure` | `{ exists, createdAt, lastUsedAt }` (no token) |
| `regenerate` | `machineProcedure` | `{ url }` (new token once) + cache-evict |
| `revoke` | `machineProcedure` | `{ ok }` — delete + cache-evict |
| `redeem` | `publicProcedure` | `{ agentName, machineName }` (token in input) |
| `whoami` | `authedProcedure` | `{ scope, agentName? }` |

---

## 6. Revocation & cache

- **Revoke** deletes the row; **Regenerate** overwrites `keyHash`/`keyPrefix`.
- Both call `bustShareCache(keyPrefix)` to evict the 30s share-token cache. Worst
  case a stale link survives ≤30s on a remote reader; on the owner's machine
  (which served the dialog) it's instant.
- Machine-key auth (5-min cache) is untouched.

---

## 7. Out of scope (v1)

- Multiple/labelled links per agent, expiry dates, per-link permission tiers
  (read-only vs full). v1 = one link, full operation, no expiry.
- Re-viewable token (we store only the hash; Regenerate is the re-copy path).
- Sandboxing the terminal (accepted escape).
- Audit log of share-link usage beyond `lastUsedAt`.

---

## 8. Build order (informs the plan)

1. Schema + migration (`AgentShareLink`, `Machine.shareLinks`).
2. `auth.ts` `resolveKey` + share cache; `trpc.ts` `authedProcedure` /
   `machineProcedure` (deny scoped) / `agentProcedure`.
3. `share.ts` router + mount.
4. Convert allowlist endpoints (§3.4) to `agentProcedure`; gate non-tRPC surfaces
   (§3.5).
5. Client: keyring flag, `app/s/[token]` landing, `useScope`, sidebar/agent-page
   hiding + route guards.
6. Share button + dialog.
7. Verify (typecheck + `next build` + runtime: owner mints link → open in a
   second browser profile → lands scoped → can operate the agent → cannot reach
   other agents/global via UI **or** direct tRPC call) → deploy.

**Verification note:** no unit-test harness in this repo — TDD steps adapt to
typecheck / `next build` / runtime checks (curl a scoped key against
`machines.list` expecting 403; against the agent's `chat.listSessions` expecting
200).
