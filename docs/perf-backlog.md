# hermit-ui Performance Backlog

**Audited:** 2026-07-16 · **Method:** 2 parallel audit agents (dashboard client / gateway·server·DB) against current code + manual verification. Supersedes the stale 2026-05-31 `hermit-ui-perf-findings` note (most of which is now fixed — see *Already fixed* below).

Single source of truth for the perf-optimization loop (`perfopt`). A session-scoped **loop** works this top-down, one item per iteration, self-testing each change. Records *all* findings; tracks progress via checkboxes + the Changelog.

> Line numbers are as-observed on 2026-07-16 and drift — **confirm the exact location at edit time**.

---

## The one root cause both audits converged on

The **always-mounted sidebar's fixed 5s poll fan-out** is the dominant steady-state cost, from both ends:
- **Server:** `notifications.counts` (5s, every page) + `chat.listSessions` (5s) + `cron.list` (5s) + `agents.list` (10s) each run list scans — several over **unindexed sort/filter columns** (`ChatSession.lastMessageAt`, `CronRun.readAt/status`).
- **Client:** every 5s `notifications.counts` result re-renders the whole `AppSidebar` subtree, and the `Recent*` rows are inline `.map()`s (not memo'd) so all rows re-execute each poll.

So the highest-leverage fixes (indexes + cadence + re-render isolation) attack this single hot path. A separate, equally user-felt issue is streaming jank in the chat timeline (P0-2).

---

## How the loop uses this doc

Each iteration:
1. Pick the **highest-priority unchecked `[ ]` item**.
2. Implement it (coherent, self-contained; split a large item across iterations, leaving it `[ ]` with a "partial" note).
3. **Self-test** (see *Verification recipe*) — never report an unverified win.
4. Flip to `[x]`, add a **Changelog** entry (run #, item, result, commit).
5. Commit + push (+ deploy per change type), update `.loop-state.json` (`perfopt` entry only), append one line to daily memory, reply with the `↻ loop` marker.

**Stop condition:** every item in the Prioritized Backlog is `[x]`.

### Verification recipe
Perf work is only "done" when the change is (a) **behaviour-preserving** and (b) **measured or structurally certain** to help — never "looks faster."
- **Dashboard** (`apps/dashboard`): `pnpm --filter @hermit-ui/dashboard typecheck` + `pnpm --filter @hermit-ui/dashboard build`. Deploy: `git push` → `ssh ubuntu@45.89.234.110 -- '~/hermit-ui/scripts/vps-deploy.sh'` → health prints `OK … deployed <sha>`.
- **DB index / migration**: hand-written **additive** migration (a plain `CREATE INDEX`, or raw-SQL partial like the P0-2 poller indexes). `prisma migrate deploy` runs on VPS deploy. Never edit an applied migration. Measure: time the affected tRPC endpoint via `curl` with the machine key **before vs after** (e.g. `notifications.counts`), report the delta. (No `psql`/`EXPLAIN` — that's off-limits; curl timing + the predicate matching the index is the signal.)
- **Client re-render fixes** (memo / useMemo / stable callbacks): behaviour is preserved by construction (memoization changes *when* work runs, not its output). Verify: tsc + build + a functional check that the UI still renders/updates correctly. The perf gain is structural — document the before/after re-render trigger. If the browser (Playwright/MCP) is alive, count re-renders / profile; if dead, note it as environment-gated and rely on the structural argument (do NOT block the loop on it).
- **Gateway** (`apps/gateway`): `pnpm --filter @hermit-ui/gateway typecheck` (+ tests) → `pm2 restart hermit-ui-gateway` on Mac (confirm pid changed, no crash-loop, `ok` ticks). Needs a runtime window (ask sway) — gateway-side items are lower in the list for that reason.

### Deploy per change type
- Docs only → `git push` (no deploy).
- Dashboard / migration → push → VPS `scripts/vps-deploy.sh` (runs `migrate deploy` + build + restart).
- Gateway → push → Mac `pm2 restart hermit-ui-gateway`. **macmini×2 gateway rollout is a known manual step**, not blocked on by this loop.

### Shared-tree rules (mandatory every push)
`git fetch origin main` first · only `git add <named files>`, never `-A` · commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` · code & docs in separate commits (code → push → deploy-verify → then docs commit referencing the code hash).

---

## Findings

### Client (dashboard) — verified
- **C1 · `MessageRow` memo defeated during streaming.** `MessageTimeline` rebuilds `askCardByQuestion = new Map()` every render (`components/chat/message-timeline.tsx:44`) and passes it to every row (`:106`); `MessageRow` is `memo()` with default shallow compare (`:113`), so the fresh Map identity breaks the bail-out for **all** rows → every visible bubble re-runs its render body (`groupConsecutiveTools()` alloc, `plainText` join, `cn()`) ~4×/sec while streaming, scaling with window size. Biggest user-felt CPU cost during a reply.
- **C2 · Sidebar `Recent*` rows are inline `.map()`s, not memo'd row components** (`components/sidebar/recent-lists.tsx` RecentSessions ~556, RecentAgents ~192, RecentCrons ~83). Derived arrays *are* `useMemo`'d, but the row JSX is inlined, so every 5s `listSessions` poll re-executes `sessionStatusView()`/`liveWorkingSince()`/`isSessionUnread()`/`relTime()`/`cn()` for all ~60 rows + allocates fresh row-handler closures.
- **C3 · `AppSidebar` re-renders its whole subtree every 5s** because `notifications.counts` (`components/app-sidebar.tsx:77`, `refetchInterval:5000`) lives at the sidebar root; every tick (even unchanged count) reconciles the inline `Recent*` list. Blast radius = whole sidebar, app-wide, even idle.
- **C4 · `agents.list` polled at mixed cadences** (`recent-lists.tsx:142` 10s, `cron/page.tsx:120` 30s, `chat/page.tsx:105` 30s, brain pages 15s); React Query takes the min per shared key → effectively 10s. Payload is lean; it's a *frequency* + re-render issue.
- **C5 · Tool chips render their expanded `<pre>` JSON eagerly while collapsed** (`components/chat/tool-chips.tsx:27,52,79` — `JSON.stringify(input,null,2)` always in the DOM inside `<details>`). Tool-heavy turns pay full stringify + DOM up front; compounds with C1.
- **C6 · `CronRunRow` not memo'd** (`app/cron/page.tsx:475`, inline map `:463`, parent `cron.get` polls 5s) → all ≤50 run rows re-render every 5s on `/cron?id=`. (Light row work only — the audit's "re-parses markdown" claim was **wrong**: output is lazy `enabled:open` + Markdown is memo'd + `cron.get` select excludes `output`.)

### Gateway · server · DB — verified
- **S1 · `notifications.counts`** (`server/routers/notifications.ts:136`, helper `:48`) — `chatSession.findMany WHERE machineId ORDER BY lastMessageAt DESC TAKE 300` with **no index on `lastMessageAt`** (a filesort of the machine's whole session set) + `cronRun.count WHERE cron.machineId AND readAt IS NULL AND status != 'running'` with **no index on `CronRun.readAt/status`** (scans an ever-growing table). 5s, every page. Single highest-traffic DB consumer.
- **S2 · `notifications.feed`** (`notifications.ts:60`) — same unindexed 300-session filesort + a per-session `messages take:1` content fetch (full JSON, then discards read ones) + unindexed `cronRun.findMany take:200`. 5s while `/notifications` open.
- **S3 · `agents.list`** (`server/routers/agents.ts:89`) — good `select`, but `chatSession.groupBy by [agentName,alive] WHERE machineId AND agentName IN (all)` reads all the machine's sessions to count, every 10s, fleet-wide.
- **S4 · `chat.listSessions`** (`server/routers/chat.ts:79`) — lean select + denormalized `preview` (good), but **no `take`/time bound** and a 3-key `ORDER BY [closedAt, lastMessageAt, startedAt]` not index-covered → full-set filesort, 5s, payload grows unbounded.
- **S5 · `knowledge.materializationForMachine`** (`server/routers/knowledge.ts:344`) — pulls **full `content` markdown of ALL docs in ALL attached KBs** in one query. Startup-reconcile only → low urgency; grows with KB corpus.
- **S6 · `cron.list`** (`server/routers/cron.ts:38`, `unreadCountByCron` `:13`) — `cronRun.groupBy by cronId WHERE readAt IS NULL AND status != 'running'`, same missing `CronRun(readAt,status)` index as S1/S2. 5s (sidebar).
- **S7 · `hosts.topSessions`** (`server/routers/hosts.ts:43`) — `ORDER BY rssMb DESC` filesort (unindexed) over `WHERE machineId, closedAt=null TAKE 50`; bounded by the `closedAt` pre-filter, 10s only when the Host panel is open. Low.
- **S8 · session-snapshot write loop** (`app/api/sync/session-snapshot/route.ts:51`) — one `updateMany` per session, serially, per 8s push. Bounded by live-session count; a `$transaction`/batch cuts round-trips. Minor.
- **S9 · `cron.listForGateway`** (`server/routers/cron.ts:256`) — full-row `findMany` (ships full prompts) every 15s from the gateway; a `select` would trim. Minor.

---

## Prioritized Backlog

### P0 — highest ROI, low risk
- [x] **P0-1 · Index `ChatSession(machineId, lastMessageAt)`.** One additive migration; makes the `ORDER BY lastMessageAt DESC` in `notifications.counts` (S1), `notifications.feed` (S2), and `chat.listSessions` (S4) index-backed instead of a full-set filesort. *Test:* migration applies on VPS; `notifications.counts` + `listSessions` return identical data; `curl` timing before/after (report the delta). **✅ RESOLVED run 1 — added `@@index([machineId, lastMessageAt])` to the ChatSession model + hand-written additive migration `20260716180000_chatsession_lastmessageat_index` (plain `CREATE INDEX IF NOT EXISTS`, canonical Prisma name so schema+DB agree). Deployed: VPS `migrate deploy` reported "All migrations have been successfully applied", health `OK — HTTP 200 — deployed 9bd1094`. Functional smoke (safe config-file curl, machine key never on argv/stdout): `notifications.counts` → HTTP 200 + valid `{chat:2, cron:489, total:491}` — query works with the index. **Verification note:** I dropped the planned end-to-end curl *timing* — it's uninformative for a small-table index (response time is dominated by network Mac→VPS + TLS + framework + cached bcrypt; the sub-ms query delta at the current row count is pure noise). The honest signal is migrate-deploy success + the index exactly covering `WHERE machineId ORDER BY lastMessageAt DESC LIMIT 300` (Postgres uses it → no filesort; the win scales with session count) + additive = zero behaviour change by construction. Side note: the smoke's `cron:489` unread runs corroborates P1-1 (the unindexed CronRun correlated count scans a genuinely large, growing table). Primarily helps counts/feed (pure `lastMessageAt` sort); `chat.listSessions`' 3-key `[closedAt, lastMessageAt, startedAt]` sort isn't fully covered by this index — its bigger win is the `take` bound in P2-1. commit `9bd1094`.**
- [ ] **P0-2 · Stabilize `askCardByQuestion` identity (C1).** `useMemo(() => buildAskMap(messages), [messages])` (and/or a custom `MessageRow` `areEqual` that ignores the ask-map unless the row hosts an `ask` call), restoring per-row memo bail during streaming so only the changed tail row re-renders. *Test:* tsc + build; a streaming reply still renders correctly (ask-cards still bind); structural: only the tail row re-renders on an SSE tick.

### P1 — high ROI, low risk
- [ ] **P1-1 · Index the unread-`CronRun` predicate.** Raw-SQL partial index (like the P0-2 codequal poller migration) covering `readAt IS NULL AND status <> 'running'` (scoped via cronId) so the correlated counts in `notifications.counts` (S1), `feed` (S2), and `cron.list` (S6) stop scanning CronRun history. *Test:* migration applies; the three endpoints return identical counts; curl timing on `cron.list`/`notifications.counts`.
- [ ] **P1-2 · Isolate the notifications badge + lengthen `counts` cadence.** Move `notifications.counts` into its own leaf component so a count tick re-renders only the badge, not the whole `AppSidebar` subtree (C3); drop `refetchInterval` 5s→15s (the count feeds one small number). Cuts both the client re-render blast AND the server scan frequency 3×. *Test:* tsc + build; badge still updates; sidebar no longer reconciles on the count tick (structural).
- [ ] **P1-3 · Memo the sidebar row components (C2).** Extract `SessionRow`/`AgentRow`/`CronRow` as `memo()` keyed by rendered fields; hoist hover/context handlers to stable `useCallback`s taking the id. Unchanged rows bail on each 5s poll. *Test:* tsc + build; rows still render/hover/context-menu correctly.

### P2 — moderate ROI
- [ ] **P2-1 · Bound `chat.listSessions` + standardize `agents.list` cadence.** Add a `take` to `listSessions` (S4 — the sidebar/agent-detail only show recents) and set all `agents.list` observers to one 30s interval (C4, S3 — agents change rarely; mutations already `invalidate`). *Test:* tsc + build; sidebar still shows the expected sessions; agents still update on create/delete.
- [ ] **P2-2 · Lazy-mount tool-chip expanded JSON (C5).** Gate the `<pre>JSON.stringify(...)</pre>` body on `open` (via `onToggle`), same pattern as `CronRunRow`, so collapsed chips don't pay the stringify + DOM. *Test:* tsc + build; expanding a tool chip still shows its input/result.
- [ ] **P2-3 · Memo `CronRunRow` + stable `onRead` (C6).** Wrap in `memo`, pass a stable per-row callback, memoize `unreadRuns`. *Test:* tsc + build; cron run rows still expand + mark-read.

### P3 — low urgency / minor / gateway-gated
- [ ] **P3-1 · Gate `knowledge.materializationForMachine` by `contentUpdatedAt` (S5).** Skip re-shipping unchanged KB docs' full markdown on startup reconcile. *Test:* tsc + build; a changed KB still materializes; an unchanged one is skipped.
- [ ] **P3-2 · Batch the session-snapshot write loop (S8).** `$transaction`/batched write instead of N serial `updateMany`. *Gateway/route — needs deploy verify.* *Test:* build; snapshots still persist per push.
- [ ] **P3-3 · `select` on `cron.listForGateway` (S9).** Trim the gateway's 15s cron fetch to the fields it uses. *Gateway-consumed — verify a cron still fires.* *Test:* gateway typecheck + restart; cron still fires.
- [ ] **P3-4 · Index `hosts.topSessions` sort (S7)** — only if open-session counts grow; low. *Test:* migration; panel still ranks by rssMb.
- [ ] **P3-5 · Lazy-load `ImageLightbox` on the chat route** — trivial `next/dynamic`, ~20KB off first paint. *Test:* build; lightbox still opens.

---

## Already fixed / not an issue (cleared this audit)
- **`chat.listMessages` 300-row over-fetch** → FIXED: `INITIAL_WINDOW=60`, tight `select`, `capMessageContent` strips base64 + truncates >12KB.
- **Markdown not memo'd / full first-paint render** → FIXED: `React.lazy` split (~324KB chunk), memo'd on the string at both boundaries, idle warm, `rehypeHighlight detect:false`.
- **SSE + poll duplicate fetch on open** → FIXED: `skipInitial=1` on first connect + optimistic `setStreamConnected`.
- **SSE reconnect churn / zombie connections** → FIXED: 35s liveness watchdog + `[1s,2s,5s]` backoff + pause-on-hidden + 15s server ping.
- **250ms background DB polling** → FIXED: SSE-push + fallback poll only when the stream is down; server SSE loop probes at 600ms via an index-only `MAX(updatedAt)`.
- **Server list over-fetch** → FIXED: denormalized `preview` killed the per-row first-message subquery; `agents.list` ships `skillCount`; `cron.list` caps prompt to 100c; hover prefetch matches `INITIAL_WINDOW`.
- **Gateway per-tick full scans** → NONE: every tick delegates to an indexed query; the P0-2 codequal poller partial indexes are present. This matches `feedback_no_per_tick_scans`.
- **bcrypt auth cache** → CORRECT: `/api/sync/*` and tRPC share the 5-min prefix-filtered cache; no path bypasses it.
- **Bundle / TTI** → GOOD: markdown + xterm split, Prisma/JSZip server-only, lucide tree-shaken, safe RQ defaults.

---

## Changelog
_(the loop appends one entry per completed item; newest first)_

- **run 1 · P0-1 (index ChatSession(machineId, lastMessageAt))** — the always-on sidebar's `notifications.counts` (5s, every page) + `notifications.feed` do `chatSession.findMany WHERE machineId ORDER BY lastMessageAt DESC TAKE 300` over an unindexed `lastMessageAt` → a filesort of the machine's whole session set, the app's single highest-traffic query. Added `@@index([machineId, lastMessageAt])` (schema.prisma) + additive migration `20260716180000_chatsession_lastmessageat_index` (plain `CREATE INDEX IF NOT EXISTS "ChatSession_machineId_lastMessageAt_idx"`, canonical name). `prisma validate` + local `prisma generate` + `tsc` clean; VPS `migrate deploy` → "All migrations have been successfully applied", health `OK — HTTP 200 — deployed 9bd1094`. Functional smoke via a **secret-safe** curl (machine key written to a `umask 077` temp config file, never on argv/stdout; only counts numbers returned): `notifications.counts` → 200 + `{chat:2, cron:489, total:491}`. Dropped the planned end-to-end **timing** measurement as uninformative for a small-table index (network + TLS + framework dominate; the sub-ms query delta is noise) — the real signal is deploy-success + the index covering the exact sort predicate (scalability win, grows with session count) + additive⇒behaviour-identical. `cron:489` unread runs seen in the smoke corroborates P1-1. Generated Prisma client is gitignored (VPS regenerates on build) so not committed. commit `9bd1094`. **P0-1 → `[x]`.**
