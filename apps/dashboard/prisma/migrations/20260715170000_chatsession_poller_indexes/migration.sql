-- Indexes backing the hot ChatSession lookups (docs/code-quality-backlog.md P0-2).
-- ChatSession had only (machineId, agentName) + (machineId, closedAt); the queries
-- below all seq-scanned the table.
--
-- 1) Composite for the interaction-sync fallback lookup
--    (apps/dashboard/src/app/api/sync/interaction/route.ts:42): resolve a session by
--    its Claude uuid when the gateway posts an interaction without the dashboard id —
--       findFirst WHERE claudeSessionId = ? AND machineId = ?
--    Non-sparse (claudeSessionId is populated once the SDK boots) + equality on both
--    columns → a plain composite. Declared in schema.prisma as @@index and created
--    here with Prisma's canonical name so schema and DB agree.
--
-- 2) Four PARTIAL indexes for the sparse request-flag pollers. Each runs every
--    ~1.5-2s (chat.ts pollCancellations / pollSessionRestarts / pollHibernations /
--    runDispatchWatch) as `WHERE machineId = ? AND <col> IS NOT NULL`. These flags
--    are NULL for essentially every row (set only for the brief window between a user
--    action and the gateway acking it), so a partial index keyed on machineId with a
--    `WHERE <col> IS NOT NULL` predicate is tiny — it indexes only the handful of
--    in-flight rows — and turns each poll from a full seq scan into a bounded index
--    scan. Prisma's @@index can't express a WHERE predicate, so these are raw SQL,
--    applied by `migrate deploy` (this repo never runs `migrate dev`). Plain CREATE
--    INDEX (not CONCURRENTLY): migrate deploy wraps the migration in a transaction and
--    the table is small, so the brief SHARE lock is sub-millisecond.

CREATE INDEX IF NOT EXISTS "ChatSession_machineId_claudeSessionId_idx"
  ON "ChatSession" ("machineId", "claudeSessionId");

CREATE INDEX IF NOT EXISTS "ChatSession_cancelRequested_partial_idx"
  ON "ChatSession" ("machineId") WHERE "cancelRequestedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ChatSession_restartRequested_partial_idx"
  ON "ChatSession" ("machineId") WHERE "restartRequestedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ChatSession_hibernateRequested_partial_idx"
  ON "ChatSession" ("machineId") WHERE "hibernateRequestedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ChatSession_openDispatch_partial_idx"
  ON "ChatSession" ("machineId")
  WHERE "dispatchedBySessionId" IS NOT NULL AND "closedAt" IS NULL;
