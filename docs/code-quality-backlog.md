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
- [ ] **P0-2 · Partial indexes on sparse-flag `ChatSession` columns.** Hand-written additive migration: partial indexes `WHERE <col> IS NOT NULL` for `cancelRequestedAt`, `restartRequestedAt`, `hibernateRequestedAt`, `dispatchedBySessionId`; plain composite `@@index([machineId, claudeSessionId])`. *Why:* 4 gateway pollers scan these every tick (`chat.ts:625-631,662-668,697-702,759-768`) on a table with only `[machineId, agentName]` + `[machineId, closedAt]` indexes. *Test:* `prisma migrate diff` clean; `EXPLAIN` shows index use on the poller queries; deploy + confirm pollers still return correct rows.

### P1 — shared contract & drift removal

- [ ] **P1-1 · Delete the 5 duplicated pane-name derivations** → use `tmuxPaneName` everywhere (start with the inline `chat-runner.ts:715`). *Test:* covered by the P0-1 pane-name test; gateway typecheck + restart + live pane resolves.
- [ ] **P1-2 · Single transcript-path derivation** — one exported helper used by `pane.ts` and `session-snapshot.ts` (dedup `pane.ts:59-65` vs `session-snapshot.ts:134-137`). *Test:* path-encoding unit test; snapshot still resolves transcripts.
- [ ] **P1-3 · `claude-code-contract` module** — centralize the Claude-Code-format constants (event-type sets, `WORK_MARKER_RE`, resume-prompt strings, transcript-path encoder) currently copied across `pane.ts` / `session-snapshot.ts` / `chat-runner.ts` / `cron-runner.ts` / `tmux-driver`. *Test:* unit tests on the constants; full gateway typecheck + restart.
- [ ] **P1-4 · Tighten the `/api/sync/*` wire schemas** — replace `content: z.any()` (`chat-message/route.ts:14`) and `state: z.string()` / `loopState: z.any()` (`session-snapshot/route.ts`) with real zod schemas / enums; ideally a shared schema module imported by both sides. *Test:* schema unit tests (valid + rejecting malformed); deploy + confirm real gateway payloads still validate (no 400 storm in err.log).
- [ ] **P1-5 · `sessionActivity(): {working, reason}` single verdict** + `resolveLiveTranscript()` shared helper — unify the 5-signal working detection and the drift-adopt logic (`chat-runner.ts:812-885` vs `cron-runner.ts:176-187`) behind one function every caller uses. *Higher risk — core delivery path; only after P0-1's net + P1-3.* *Test:* unit tests over the verdict function (each signal + each cap); live parity check that snapshot/chat/reaper verdicts match the old behavior on ≥10 panes.

### P2 — decomposition & structural safety

- [ ] **P2-1 · Tenancy: make `assertAgent` construction-enforced** for id-keyed procedures + add an explicit `gatewayProcedure` alias for machine-wide writes + add ownership checks to `market.ts` publish/delete/rename. *Security-relevant.* *Test:* a test proving a `shr_` scoped key is rejected on an id-keyed endpoint it doesn't own; existing endpoints still work.
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
