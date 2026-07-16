-- Partial covering index for hosts.topSessions (docs/perf-backlog.md P3-4, finding S7).
--
-- hosts.topSessions (server/routers/hosts.ts:43 — the Host panel's "Top memory
-- sessions" list, polled ~10s while that panel is open) runs:
--     WHERE "machineId" = ? AND "closedAt" IS NULL
--     ORDER BY "rssMb" DESC NULLS LAST
--     LIMIT 50
-- ChatSession had (machineId, closedAt) which serves the filter but NOT the sort, so
-- the rssMb ordering was a heap filesort over every open session on the machine.
-- Bounded (closedAt IS NULL pre-filter + TAKE 50) and only while the panel is open,
-- hence low priority — but it grows with the machine's open-session count.
--
-- Design — mirrors the P1-1 (20260716190000) partial-index reasoning:
--   * `closedAt: null` compiles to a literal `"closedAt" IS NULL`, so the planner can
--     always prove this partial index applies — in both custom and generic
--     prepared-statement plans. Restricting to open sessions keeps the index small.
--   * (machineId, rssMb DESC NULLS LAST): machineId equality fixes the leading column,
--     then rows are already in the exact ORDER BY order (rssMb DESC NULLS LAST), so the
--     index feeds ORDER BY + LIMIT 50 directly — no filesort.
--
-- Raw SQL (Prisma @@index can express neither the WHERE predicate nor DESC NULLS LAST
-- — same as 20260715170000 / 20260716190000), applied by `migrate deploy`. Plain
-- CREATE INDEX (not CONCURRENTLY): migrate deploy wraps the migration in a transaction
-- and the table is small, so the brief SHARE lock is sub-millisecond.

CREATE INDEX IF NOT EXISTS "ChatSession_machineId_rssMb_open_idx"
  ON "ChatSession" ("machineId", "rssMb" DESC NULLS LAST) WHERE "closedAt" IS NULL;
