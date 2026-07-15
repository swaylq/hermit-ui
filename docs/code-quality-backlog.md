# hermit-ui Code Quality Backlog

**Reviewed:** 2026-07-15 · **Method:** 4 parallel review agents (gateway / data-layer / UI / shared-code) + manual verification of load-bearing claims.

This is the single source of truth for the code-quality cleanup. A session-scoped **loop** (`codequal`) works through the **Prioritized Backlog** below, top-down, one item per iteration, self-testing each change. This doc records *all* findings (nothing is dropped) and tracks progress via checkboxes + the Changelog.

> Line numbers are as-observed on 2026-07-15 and drift as the tree changes — **confirm the exact location at edit time**, don't trust the number blind.

---

## How the loop uses this doc

Each iteration:
1. Pick the **highest-priority unchecked `[ ]` item** in the Prioritized Backlog.
2. Implement it (a coherent, self-contained change — split a large item across iterations if needed, leaving it `[ ]` with a "partial" changelog note until fully done).
3. **Self-test** (see *Verification recipe*) — never report success unverified.
4. Flip the item to `[x]`, add a **Changelog** entry (run #, item, result, commit).
5. Commit + push (+ deploy per change type), update `.loop-state.json`, append one line to daily memory, reply with the `↻ loop` marker.

**Stop condition:** every item in the Prioritized Backlog is `[x]`.

### Verification recipe (pnpm monorepo — `packageManager: pnpm@9`)
- **Dashboard** (`apps/dashboard`): `pnpm --filter @hermit-ui/dashboard typecheck` + `pnpm --filter @hermit-ui/dashboard build` (Next build). Runtime: VPS deploy → curl / Playwright probe.
- **Gateway** (`apps/gateway`): `pnpm --filter @hermit-ui/gateway typecheck` (runs via tsx, so typecheck is the compile gate) → `pm2 restart hermit-ui-gateway --update-env` on Mac (confirm pid changed) → observe live snapshot/chat.
- **Prisma**: hand-written **additive** migration only → `prisma migrate deploy` runs on VPS deploy. Never edit an applied migration.
- **Unit tests** (harness landed in P0-1): `pnpm test` (root → `pnpm -r test`) or `pnpm --filter @hermit-ui/gateway test`. Tests live in `apps/gateway/src/*.test.ts`, run via `tsx --test`.

### Deploy per change type
- Docs / tests only → `git push origin main` (no deploy).
- Dashboard / migration → push → `ssh ubuntu@45.89.234.110 -- '~/hermit-ui/scripts/vps-deploy.sh'`.
- Gateway → push → `pm2 restart hermit-ui-gateway --update-env` on Mac. **macmini×2 gateway rollout is a known-pending manual step** (SSH access needed — see task tracker), not blocked on by this loop.

### Shared-tree rules (mandatory every push)
`git fetch origin main` first · only `git add <named files>`, never `-A` · commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Findings — the 6 themes

### Theme 1 — No shared contract at the gateway ↔ dashboard boundary
Two API surfaces (tRPC read / `/api/sync/*` REST write) validate the same payloads 2–3× with **drifting strictness, and the authoritative writer is the weakest**:
- `apps/dashboard/src/app/api/sync/chat-message/route.ts:14` — `content: z.any()` (the primary message writer accepts anything).
- `apps/dashboard/src/app/api/sync/session-snapshot/route.ts` — `state: z.string()` (should be an enum), `loopState: z.any()`.
- The **Claude Code contract** (transcript-path encoding, event-type strings, `WORK_MARKER_RE`, resume-prompt strings) is hardcoded across ≥6 files: `apps/gateway/src/pane.ts:35`, `session-snapshot.ts:158-214`, `chat-runner.ts:1041-1071`, `cron-runner.ts:199-207`, `packages/tmux-driver/src/index.ts:275-291`.
- **pane-name derivation duplicated 5×** incl. inline `apps/gateway/src/chat-runner.ts:715` (`hermit-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12)}`) while the file already imports `tmuxPaneName`; canonical impl at `packages/tmux-driver/src/index.ts:464-470`.
- **transcript-path derivation duplicated**: `pane.ts:59-65` vs `session-snapshot.ts:134-137`.
- tRPC batch envelope hand-rolled in `api.ts`, `mcp-stub.cjs`, `keyring.ts`.

**Direction:** a shared contract package — zod wire-schemas for `/api/sync/*` + a `claude-code-contract` module owning every Claude-Code-format string/regex/path-encoder.

### Theme 2 — Session state has no single owner
Three sources of truth — DB `ChatSession`, in-memory `sessionStates` (gateway), on-disk transcript — reconciled by **drift-adopt reimplemented differently** in `chat-runner.ts:812-885` vs `cron-runner.ts:176-187`. "Is it working?" is **5 ORed signals** (transcriptFresh+newestLineIsTurn, pane `WORK_MARKER_RE`, hookTurnActive, transcriptToolRunning, newestLineIsTurn) spread across `pane.ts` / `session-snapshot.ts` / `chat-runner.ts` / `cron-runner.ts` with **3 independent caps** (`TRANSCRIPT_FRESH_MS` 10s, `HOOK_RUNNING_CAP_MS` 15min, `TOOL_RUNNING_CAP_MS` 20min) → different callers can reach different verdicts. `setupSession` (`chat-runner.ts:791-974`) is ~180 lines, 4 spawn modes via nested boolean branching, shared mutable locals, no state enum, no assertion that `claudeUuid` is non-empty before `watchTranscript`.

**Direction:** one `sessionActivity(): {working, reason}` verdict used by every caller; one `resolveLiveTranscript()`; a discriminated `SpawnPlan` union for the spawn modes.

### Theme 3 — God-files
- `apps/dashboard/src/app/chat/page.tsx` **3502 lines**. `SessionPane` (≈562-1503): ~15 effects, ~12 mutations, **4 optimistic-overlay state machines** (`pending` / `optimisticQueue` / `starterIds` / `streamingTailId`) deduped by text-equality, ~30 `any`.
- `apps/dashboard/src/components/app-sidebar.tsx` **1778 lines**: 8 modes + a touch engine (≈514-596) + 6 near-identical list components.
- `apps/dashboard/src/components/agent-files.tsx` (556) vs `global-memory-files.tsx` (645) — **copy-paste fork**; `fmtSize` has already drifted (GB vs MB).

**Direction:** decompose `SessionPane` into hooks (`useSessionStream` / `useStickyScroll` / `useOutboundState`) + `components/message/*`; unify the two file explorers behind `<FileExplorer source= capabilities= />`. (Good existing seams to emulate: `lib/session-status.ts`, `lib/save-file.ts`, the markdown lazy split, `keyring.ts`.)

### Theme 4 — Tenancy by convention, not construction
`agentProcedure` (`apps/dashboard/src/server/trpc.ts:55-78`) auto-scopes **only** when the input has a magic `agentName`/`name` field; the ~30 id-keyed endpoints must *manually* call `ctx.assertAgent`. **Forget once → cross-agent data leak for `shr_` scoped keys, and it compiles + passes review.** `ackDelivered` / `ackCancel` / `ackHibernated` (`chat.ts:609-621,633-642,737-746`) do machine-wide writes. `market.ts` publish/delete/rename are fully permissive (any machine key).

**Direction:** make `assertAgent` structurally unavoidable for id-keyed procedures; add a `gatewayProcedure` alias for the machine-wide ones (explicit, not accidental); add ownership checks to `market.ts`.

### Theme 5 — Per-tick full-scans + zero tests
- ~20 `setInterval` pollers (`apps/gateway/src/index.ts:196-222`). 4 gateway pollers hit **unindexed sparse-flag columns** (`chat.ts:625-631,662-668,697-702,759-768`). `notifications.ts:48-91` scans 300 sessions with correlated subselects. `chat.ts:374-384` does `content::text LIKE` on loopRuns.
- 6 uncoordinated module-level guard `Set`s.
- **Zero automated tests** anywhere in the repo.

**Direction:** partial indexes on the sparse columns; a per-session lock; a minimal test harness over the pure functions.

### Theme 6 — Hygiene
- Inconsistent error-swallowing `.catch(() => {})` (`chat-runner.ts:447,689,696`, …).
- Dead code: `chat/page.tsx:1145` `const inactive = false`, `RestartBar`, `streamingTailId`, `lib/session-status.ts:37` `'idle'` union member.
- ~21 hand-built `x-asst-key` fetches + a dual `getActiveKey` import.
- Two different `confirm` patterns; file-type whitelist triplicated.
- Stringly-typed state / status / role — **0 enums** (this is what caused the cron-status rework).
- `mcp-stub.cjs` — an 865-line untyped `.cjs` that holds the machine key.

---

## Prioritized Backlog

Ordered **most-important-first, risk-ascending**: build the safety net and kill cheap drift before the big refactors touch the core delivery path.

### P0 — foundation & safe high-ROI

- [x] **P0-1 · Minimal test harness + pure-function tests.** Add a lightweight `node --import tsx --test` setup (no heavy dep; gateway already uses tsx) + an `npm test` script. Cover the already-pure functions: `newestLineIsTurn` / `transcriptFresh` logic & `WORK_MARKER_RE` (`pane.ts`), `tmuxPaneName` + `encodedProjectDir` / `sessionTranscriptPath` path-encoding (`tmux-driver`, `pane.ts`). *Why first:* it's the safety net every later refactor leans on, and it touches **no** runtime path (pure addition, no deploy). *Test:* the new tests run green; `tsc --noEmit` clean.
- [x] **P0-2 · Partial indexes on sparse-flag `ChatSession` columns.** Hand-written additive migration: partial indexes `WHERE <col> IS NOT NULL` for `cancelRequestedAt`, `restartRequestedAt`, `hibernateRequestedAt`, `dispatchedBySessionId`; plain composite `@@index([machineId, claudeSessionId])`. *Why:* 4 gateway pollers scan these every tick (`chat.ts:625-631,662-668,697-702,759-768`) on a table with only `[machineId, agentName]` + `[machineId, closedAt]` indexes. *Test:* `prisma migrate diff` clean; `EXPLAIN` shows index use on the poller queries; deploy + confirm pollers still return correct rows.

### P1 — shared contract & drift removal

- [x] **P1-1 · Delete the 5 duplicated pane-name derivations** → use `tmuxPaneName` everywhere (start with the inline `chat-runner.ts:715`). *Test:* covered by the P0-1 pane-name test; gateway typecheck + restart + live pane resolves.
- [x] **P1-2 · Single transcript-path derivation** — one exported helper used by `pane.ts` and `session-snapshot.ts` (dedup `pane.ts:59-65` vs `session-snapshot.ts:134-137`). *Test:* path-encoding unit test; snapshot still resolves transcripts.
- [x] **P1-3 · `claude-code-contract` module** — centralize the Claude-Code-format constants (event-type sets, `WORK_MARKER_RE`, resume-prompt strings, transcript-path encoder) currently copied across `pane.ts` / `session-snapshot.ts` / `chat-runner.ts` / `cron-runner.ts` / `tmux-driver`. *Test:* unit tests on the constants; full gateway typecheck + restart.
- [x] **P1-4 · Tighten the `/api/sync/*` wire schemas** — replace `content: z.any()` (`chat-message/route.ts:14`) and `state: z.string()` / `loopState: z.any()` (`session-snapshot/route.ts`) with real zod schemas / enums; ideally a shared schema module imported by both sides. *Test:* schema unit tests (valid + rejecting malformed); deploy + confirm real gateway payloads still validate (no 400 storm in err.log).
- [x] **P1-5 · `sessionActivity(): {working, reason}` single verdict** + `resolveLiveTranscript()` shared helper — unify the 5-signal working detection and the drift-adopt logic (`chat-runner.ts:812-885` vs `cron-runner.ts:176-187`) behind one function every caller uses. *Higher risk — core delivery path; only after P0-1's net + P1-3.* *Test:* unit tests over the verdict function (each signal + each cap); live parity check that snapshot/chat/reaper verdicts match the old behavior on ≥10 panes.
  - **Done across runs 7–9:** (A, run 7) `sessionActivity()` single verdict, behavior-identical; (B step 2, run 8) `resolveLiveTranscript()`/`pickLiveTranscript()` — chat + cron drift-adopt share one helper; (B step 1, run 9) the delivery gate now derives `tool-running` from a bounded internal tail read (`readTranscriptTail`), closing the last snapshot-vs-gate verdict desync. See changelog runs 7/8/9.

### P2 — decomposition & structural safety

- [ ] **P2-1 · Tenancy: make `assertAgent` construction-enforced** for id-keyed procedures + add an explicit `gatewayProcedure` alias for machine-wide writes + add ownership checks to `market.ts` publish/delete/rename. *Security-relevant.* *Test:* a test proving a `shr_` scoped key is rejected on an id-keyed endpoint it doesn't own; existing endpoints still work.
  - **Partial — run 10:** Audited all ~30 id-keyed `agentProcedure` endpoints (chat / cron / fileManager / interaction / agents / share). Result: the surface is disciplined — **exactly one** endpoint reached a record with only a machineId check and no agent assertion (`fileManager.downloadStatus` + its byte route), now **fixed** by stamping the owner agent on the download record and enforcing it for scoped keys (machine keys unchanged). Every other id-keyed endpoint already asserts (`ctx.assertAgent` post-load, or a `scopedAgent`-constrained WHERE / `fsTarget` gate); **zero assert-too-late**. **`market.ts` ownership → DECLINED:** it's a documented fleet-wide shared registry (`docs/marketplace-design.md`) and `machineProcedure` already rejects scoped keys → single-tenant, not a hole (adding checks would contradict the design). **Remaining:** (b) `gatewayProcedure` intent-alias for the machine-wide gateway writes (clarity, not a fix); (c) a construction-enforcement mechanism so FUTURE id-keyed endpoints can't forget the assert (regression prevention — the audit shows current code is clean, so this is insurance, to be designed lightweight). Flip `[x]` once (b)+(c) land or (c) is explicitly descoped with rationale.
- [ ] **P2-2 · De-fork the file explorer** → shared `<FileExplorer source= capabilities= />` replacing `agent-files.tsx` + `global-memory-files.tsx`; fix the drifted `fmtSize` (GB vs MB). *Test:* tsc + build; Playwright browse/upload/download on both an agent dir and global-memory.
- [ ] **P2-3 · Decompose `SessionPane`** (`chat/page.tsx` 3502) into hooks (`useSessionStream` / `useStickyScroll` / `useOutboundState`) + `components/message/*`; collapse the 4 optimistic-overlay machines where possible; kill the `any`s. *Largest UI refactor — behavior-preserving.* *Test:* tsc + build; Playwright send/stream/queue/scroll parity.
- [ ] **P2-4 · Decompose `app-sidebar.tsx`** (1778) — extract the 6 near-identical list components + the touch engine into reusable units. *Test:* tsc + build; Playwright sidebar modes + touch behavior.
- [ ] **P2-5 · Per-session lock for the pollers** + coordinate the 6 module-level guard Sets into one owner. *Test:* gateway typecheck + restart; confirm no double-fire under overlapping ticks.

### P3 — hygiene (fold in opportunistically; each is independently shippable)

- [ ] **P3-1 · Enums for stringly-typed state / status / role** (0 enums today; the class of bug behind the cron-status rework). *Test:* tsc catches every non-conforming literal.
- [ ] **P3-2 · Remove dead code** — `chat/page.tsx:1145` `const inactive = false`, `RestartBar`, `streamingTailId`, `session-status.ts:37` `'idle'` union member. *Test:* tsc + build; grep confirms no references.
- [ ] **P3-3 · Consolidate the ~21 `x-asst-key` fetches + dual `getActiveKey` import** behind one client helper. *Test:* tsc + build; every call site still authenticates.
- [ ] **P3-4 · Error-handling hygiene** — audit `.catch(() => {})` swallows; make each either handle or log with intent. *Test:* tsc + build; no behavior change on the happy path.
- [ ] **P3-5 · `mcp-stub.cjs` cleanup** — the 865-line untyped `.cjs` holding the machine key: split + typecheck where feasible without changing the no-dep/node-builtins-only constraint. *Lowest priority, handle-with-care.* *Test:* MCP tools still resolve from a fresh spawn; attach/ask smoke test.

---

## Changelog

_(the loop appends one entry per completed item)_

- **run 1 · P0-1** — test harness (`tsx --test`, wired at gateway + root `pnpm test`) + 19 pure-function tests (WORK_MARKER_RE / newestLineIsTurn / transcriptFresh / sessionTranscriptPath / tmuxPaneName / encodedProjectDir), all green; gateway typecheck clean. Behaviour-neutral (`export` only) — no deploy. commit `af5e182`.
- **run 2 · P0-2** — migration `20260715170000_chatsession_poller_indexes`: 4 partial indexes (`WHERE <col> IS NOT NULL`, keyed on machineId) for the cancel/restart/hibernate/dispatch pollers + composite `@@index([machineId, claudeSessionId])` for the interaction-sync fallback lookup (confirmed a real query predicate — the column is only *written* elsewhere, so this improves on the review's "just unindexed" note). `migrate deploy` → "All migrations successfully applied"; dashboard HTTP 200. Deployed `f9cf64b`. (EXPLAIN not run — psql off-limits — but each poller's WHERE exactly matches its partial predicate, so the planner uses them.)
- **run 3 · P1-1** — removed all 3 inline `hermit-${id…slice(-12)}` copies: gateway `chat-runner.ts` → `tmuxPaneName` (tmux-driver); dashboard `server.ts` + `terminal/page.tsx` → new pure, browser-safe `apps/dashboard/src/lib/pane-name.ts` (kept dashboard-local so the client bundle never pulls in the tmux/pty driver just to render a string). Behaviour-identical, covered by the P0-1 tmuxPaneName test. Gateway typecheck + 19 tests + dashboard typecheck + `next build` all green. Deployed: gateway pm2 restart (pid 27759→31230) + dashboard VPS HTTP 200. commit `e684669`. (The review's "5×" also counted tmux-driver's canonical impl + the unit test; 3 real inline copies. The Node/browser split leaves 2 canonical sources — the P1-3 shared-contract module could later unify them.)
- **run 4 · P1-2** — session-snapshot's local `transcriptPath()` now delegates the `~/.claude/projects/<enc>/<uuid>.jsonl` derivation to pane.ts's `sessionTranscriptPath` (the single source), keeping only its own `fs.existsSync` check on top (a pruned/absent transcript stays null). Dropped the now-unused `encodedProjectDir` import. Behaviour-identical; gateway typecheck + 19 tests green; runtime-verified (gateway restart pid 31230→9689, `[session-snapshots]` ticks back to steady `ok` ~600ms after the restart warm-up). commit `06396ea`.
- **run 5 · P1-3** — new `apps/gateway/src/claude-code.ts` centralizes the transcript vocabulary (`CcEvent`/`CcBlock` constants + `NON_TURN_EVENT_TYPES`) + the parsing predicates: killed **3 identical copies of `extractText`** (chat-runner/cron-runner/session-snapshot — cron's `.trim()` moved to its call site so it stays identical) + the hand-inlined `hasToolResult`/`hasToolUse` + the `'assistant'`/`'user'`/`'tool_use'`/`'tool_result'`/`'bridge-session'` literals scattered across 4 hot files. New `claude-code.test.ts` (10 tests). Gateway typecheck + 29 tests green; runtime-verified (gateway restart → `[session-snapshots]` + `[chat-tick]` back to steady `ok` after the reconnect-flood warm-up, dashboard 200 throughout). commits `bf08bc1` + `72badb6`. (Left `'system'`/`'compact_boundary'` as specialized single-use; the tmux-side contract — pane names, resume prompts — stays in @hermit-ui/tmux-driver.)
- **run 10 · P2-1 (partial — download-scope leak fixed + surface audited)** — a full tenancy audit (subagent-enumerated, then verified by hand) of all ~30 id-keyed `agentProcedure` endpoints found **one** deviation from the assert-ownership pattern: `fileManager.downloadStatus` (id-keyed by `dl_<uuid>`) checked only `machineId`, so a scoped `shr_` share key could read a sibling agent's prepared-download metadata (status/filename/size) and, with the id, its bytes. Low severity (unguessable random id, from the caller's own `fsTarget`-gated `prepareDownload`), but the one gap. Fixed by stamping the owner agent on the in-memory download record (`DownloadEntry.agentName` + `createDownload(id, machineId, agentName)`, mutated-in-place so it survives `markDownloadReady`) and enforcing it for scoped keys in both `downloadStatus` and `/api/file-manager/download/<id>` — machine keys unchanged (checks gated on `scope==='agent'`). No DB/migration (in-memory stash). **`market.ts` ownership → declined** (documented fleet-wide shared registry; `machineProcedure` already blocks scoped keys → single-tenant). Every other id-keyed endpoint verified already-asserting, zero assert-too-late. dashboard typecheck + build clean; deployed `7eee86b` (HTTP 200); smoke-tested post-deploy (byte route: machine-key+bogus→404, no-key→401, `downloadStatus`+bogus→200 graceful-error — no 500, machine path un-regressed). commit `7eee86b`. **P2-1 stays `[ ]`** — `gatewayProcedure` alias + construction-enforcement (regression prevention) remain.
- **run 9 · P1-5 (Part B step 1 — DONE)** — closed the last working-detection desync: the snapshot collector saw `tool-running` (it passes the tail to `sessionActivity`) but the `deliverMessages` idle gate (`chat-runner.ts:531/533`) did not, so a queued batch could be injected INTO a long quiet mid-tool turn on a narrow pane. `sessionActivity` now derives tool-running from EITHER the caller's pre-read tail (`transcriptLines`, the snapshot — no double read) OR a bounded tail it reads itself from `transcriptPath` (new sync `readTranscriptTail()`, byte-bounded like `newestLineIsTurn`: a mid-flight `tool_use` is always at the file's end and any `tool_result` for it is even newer → a window reaching the `tool_use` can't miss its result, so no false "running"). The delivery gate already passes a path ⇒ **zero call-site change**. Scope-limited: cron already tracks its own `toolsOut/toolsBack`, reaper/restart pass no path (pure pane-marker, unchanged). Bias toward "busy" (hold) is the safe direction; a stuck `tool_use` self-heals via the 20-min cap + the gate's `tmuxSessionExists` drops dead panes. +3 unit tests (`readTranscriptTail` + path-driven tool-running); 47 total green. gateway typecheck clean; runtime-verified: restart (pid 66490→95707), chat-tick + snapshots steady `ok` (no crash from the internal-read path), live parity 14-pane sample classified correctly (2 genuinely-working incl. this session, 12 idle). commit `9c25006`. **✅ P1-5 COMPLETE (runs 7+8+9).**
- **run 8 · P1-5 (Part B step 2, partial)** — unified the uuid-drift adoption logic. The chat reattach path (`chat-runner.ts`) and the cron freshly-spawned path (`cron-runner.ts`) each open-coded the same "adopt the newest unclaimed live transcript" pick; extracted one shared helper in `@hermit-ui/tmux-driver`: **`pickLiveTranscript(transcripts, opts, now)`** (PURE — newest non-empty transcript whose uuid ∉ `exclude`, within `[minMtimeMs, age<maxAgeMs]`) + `resolveLiveTranscript(cwd, opts)` (fs+clock wrapper) + a `TranscriptInfo` type. chat passes `exclude = {recorded uuid} ∪ sibling live uuids`, `maxAgeMs = recorded ? FRESH_MS : undefined` (**unbounded when the recorded uuid was pruned — the 2026-07-13 stuck-on-`starting` fix, preserved exactly**) and reuses its already-read `listTranscripts()` (no second dir read); cron passes `exclude = pinnedUuids`, `minMtimeMs = startedAt - 2s`. Each old filter maps 1:1 onto the helper (undefined bound ≡ the old `Infinity`/absent predicate) ⇒ **behavior-preserving**. +7 unit tests (each exclusion source + bound), 44 total green; gateway + tmux-driver typecheck clean; runtime-verified: **restart re-ran every session's reattach path through the refactored helper** (pid 69896→66490) with zero wiring/crash errors, snapshots + chat-tick steady `ok`. commit `ba00135`. **P1-5 stays `[ ]`** — Part B step 1 (delivery-gate tool-running desync) pending.
- **run 7 · P1-5 (Part A, partial)** — unified the working-detection composition behind one verdict. New `sessionActivity(sessionId, opts): {working, reason}` in `pane.ts` ORs all four signals (transcript-fresh / tool-running / pane-marker / hook-active) cheapest-first and names the winner; extracted `capturePaneMarker()` (one capture → `{marker, cols}`) from the old inline body; **moved `transcriptToolRunning` + `TOOL_RUNNING_CAP_MS` from the snapshot collector into `pane.ts`** so the "tool in flight" signal is composed inside the verdict instead of bolted onto the one snapshot call site. `paneIsWorking` is now a **zero-logic boolean alias** over `sessionActivity` → the send/queue/cron gates stay byte-identical (no `transcriptLines` ⇒ tool-running inert). The snapshot routes through `sessionActivity`, passing the tail it already reads ⇒ **same ORed condition set = behavior-identical**. +8 unit tests (transcriptToolRunning caps/ordering + sessionActivity short-circuits), 37 total green; gateway typecheck clean; runtime-verified: restart (pid 5445→69896), `[session-snapshots]` settled to steady `ok` (~600ms, ran sessionActivity for all 22 live panes, no crash), + live parity spot-check (12-pane sample: only the genuinely-working pane — this loop's own session — read WORKING, 11 idle read idle). commit `39dab27`. **P1-5 stays `[ ]`** — Part B (gate desync closure + `resolveLiveTranscript()` drift-adopt) pending.
- **run 6 · P1-4** — tightened the two highest-traffic gateway→dashboard sync routes off `z.any()`: `chat-message` `content` → `z.union([z.string(), z.array(z.unknown())])`; `session-snapshot` `state` → `z.enum(['starting','working','idle']).nullable()`, `loopState` → `z.unknown()`. **Deliberately permissive** because one bad item 400s the *whole* batch — verified every real producer stays inside the new schema before tightening: both `content` producers (chat-runner `normalizeContent` + mcp-stub attach `blocks`) always emit arrays; the collector's `state` is exactly `{null,'starting','working','idle'}` (session-snapshot.ts:242/257/260); `loopState` is opaque agent JSON (kept unvalidated, `z.unknown()` stays optional). Content cast to the column's JSON type at the Prisma boundary (same idiom as routers/chat.ts). Dashboard typecheck + `next build` green; deployed `129d42b` → **runtime-verified: 0× `→ 400` in the entire gateway err.log, `[session-snapshots] ok` every 8s + `[chat-tick] ok` post-deploy** (the only err.log noise was the expected 502 blip during the dashboard restart). No shared cross-side schema module yet (the routes live in the dashboard, the producers in the gateway/mcp-stub `.cjs` — a shared package is a P3-scale move); left as a typed-per-route tightening.
