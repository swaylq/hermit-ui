-- Cross-device unread tracking. Read-state used to live in browser localStorage
-- (per-device, never synced); move it into the DB so the red/green dot is the
-- same on every device. Two additive nullable columns + a backfill that marks
-- all existing rows "read" so the rollout doesn't flash everything unread.

-- ChatSession: when the user last viewed this session. unread = lastMessageAt > lastReadAt.
ALTER TABLE "ChatSession" ADD COLUMN "lastReadAt" TIMESTAMP(3);
UPDATE "ChatSession" SET "lastReadAt" = "lastMessageAt" WHERE "lastMessageAt" IS NOT NULL;

-- CronRun: null = unread (red dot once the run is finished). Existing runs start read.
ALTER TABLE "CronRun" ADD COLUMN "readAt" TIMESTAMP(3);
UPDATE "CronRun" SET "readAt" = COALESCE("finishedAt", "firedAt");
