-- Where tapping a banner / push lands (stuck sweep: the oldest stuck session's
-- chat; watchdog/reaper reports: /watchdogs).
ALTER TABLE "MachineAlert" ADD COLUMN "linkPath" TEXT;
