-- Index backing the hot notifications scans (docs/perf-backlog.md P0-1).
--
-- notifications.counts (5s, mounted in the always-on sidebar on every page) and
-- notifications.feed (5s while /notifications is open) both do
--   chatSession.findMany WHERE machineId = ? ORDER BY lastMessageAt DESC TAKE 300
-- ChatSession had no index on lastMessageAt, so Postgres filesorted the machine's
-- entire session set to take the top 300 — the single highest-traffic DB query in
-- the app. (machineId, lastMessageAt) turns that into a bounded index range scan
-- (equality on machineId, read in lastMessageAt order, stop after 300).
--
-- Declared in schema.prisma as @@index with Prisma's canonical name so schema and DB
-- agree. Plain CREATE INDEX (not CONCURRENTLY): migrate deploy wraps the migration in
-- a transaction and the table is small, so the brief SHARE lock is sub-millisecond.

CREATE INDEX IF NOT EXISTS "ChatSession_machineId_lastMessageAt_idx"
  ON "ChatSession" ("machineId", "lastMessageAt");
