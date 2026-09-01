-- Cron catch-up window — run a failed daily task again the same day.
--
-- 2026-09-01: sway-media's daily report fired at 01:54Z, the spawned Claude Code
-- failed one OAuth refresh, and the run ended `error` 10s later. The task runs once
-- a day and nothing re-ran it, so that day's report simply does not exist. The
-- failure was transient — another process refreshed the same token seven minutes
-- later — so one catch-up would have cost nothing and saved the day's output.
--
-- OPT-IN by design: both columns NULL means the row behaves exactly as it did
-- before, and a cron that sends or publishes must never have them set by default.
ALTER TABLE "Cron" ADD COLUMN "retryEverySec"  INTEGER;
ALTER TABLE "Cron" ADD COLUMN "retryWindowSec" INTEGER;
-- Internal state, not settings.
ALTER TABLE "Cron" ADD COLUMN "retryUntil" TIMESTAMP(3);
ALTER TABLE "Cron" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
