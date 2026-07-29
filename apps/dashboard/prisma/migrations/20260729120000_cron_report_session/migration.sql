-- Where a cron's report is delivered.
--
-- Crons run isolated (a throwaway pane per fire, so a daily job can't grow a chat's
-- context without bound) and their output only ever landed in /cron, which is a page
-- you have to remember to visit. A cron now carries the session it should report into,
-- defaulting to the one it was created from.
--
-- SET NULL rather than CASCADE: deleting a conversation must not delete the schedule
-- that happened to report into it. The cron keeps running and falls back to /cron only.
ALTER TABLE "Cron" ADD COLUMN "reportSessionId" TEXT;

ALTER TABLE "Cron" ADD CONSTRAINT "Cron_reportSessionId_fkey"
  FOREIGN KEY ("reportSessionId") REFERENCES "ChatSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Cron_reportSessionId_idx" ON "Cron" ("reportSessionId");
