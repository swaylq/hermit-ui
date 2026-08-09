-- Session cleanup (docs/session-cleanup-design.md).
--
-- The sidebar had grown to 125 sessions on mac001, 57% of them untouched for over
-- a week, with nothing that ever narrows the list. Cleanup adds a recycle bin between
-- "archived" and "gone", because those two were the only options and the gap
-- between them is the whole problem: archiving keeps 904MB of message JSON alive
-- forever, and deleting is irreversible AND leaks the session's ~500MB claude
-- process (its pane outlives the row that was the only thing able to kill it).
--
-- Purely additive: every column is nullable or defaulted, so existing rows stay
-- valid with no backfill. Applied with `migrate deploy` (this repo never runs
-- `migrate dev`), which is also why the partial index below is hand-written.

-- Recycle bin. Non-null = hidden from every list, restorable, and purged by the
-- gateway once it has been here longer than Machine.trashRetainDays.
ALTER TABLE "ChatSession" ADD COLUMN "trashedAt" TIMESTAMP(3);

-- Why cleanup put it in the bin ('dispatch-done' | 'stillborn' | 'empty' | 'idle'
-- | 'agent-trashed' | 'manual'). Shown in the trash view so a misjudged call is
-- visible immediately rather than inferred later.
ALTER TABLE "ChatSession" ADD COLUMN "trashReason" TEXT;

-- "Keep": never offer this session as a cleanup candidate again. Without it the
-- same declined sessions are re-proposed on every run.
ALTER TABLE "ChatSession" ADD COLUMN "keepAt" TIMESTAMP(3);

-- Auto-archive threshold in days; NULL = off. Reversible tiers only.
ALTER TABLE "Machine" ADD COLUMN "cleanupIdleDays" INTEGER;

-- Recycle-bin retention before purge.
ALTER TABLE "Machine" ADD COLUMN "trashRetainDays" INTEGER NOT NULL DEFAULT 14;

-- Audit trail for the REVERSIBLE half of a cleanup run. The destructive half
-- audits itself (each binned session carries trashedAt + trashReason and is
-- visible in the trash view); an archive sweep would otherwise leave no trace.
ALTER TABLE "Machine" ADD COLUMN "lastCleanupAt" TIMESTAMP(3);
ALTER TABLE "Machine" ADD COLUMN "lastCleanupSummary" JSONB;

-- PARTIAL index, like the poller indexes in 20260715170000 and the stall index in
-- 20260802010000: the trash view and the gateway's purge poll both ask
-- "WHERE machineId = ? AND trashedAt IS NOT NULL", which matches zero rows almost
-- always. A full index over every session to serve an empty set is the wrong
-- trade; Prisma's @@index cannot express the WHERE, so it lives here.
CREATE INDEX "ChatSession_machineId_trashedAt_idx"
  ON "ChatSession" ("machineId", "trashedAt")
  WHERE "trashedAt" IS NOT NULL;

-- Transcript disk accounting, pushed on the existing host-stat tick (the gateway
-- rescans at most once a day and carries the memo). Report-only by design: the
-- projects dir holds every claude run on the host, the human's own terminal
-- sessions included, so nothing sweeps it — a transcript is deleted at purge
-- time, while the session row naming it still exists to prove it is ours.
ALTER TABLE "HostStat" ADD COLUMN "transcriptTotalMb" INTEGER;
ALTER TABLE "HostStat" ADD COLUMN "transcriptCount" INTEGER;
ALTER TABLE "HostStat" ADD COLUMN "transcriptOrphanMb" INTEGER;
ALTER TABLE "HostStat" ADD COLUMN "transcriptOrphanCount" INTEGER;
