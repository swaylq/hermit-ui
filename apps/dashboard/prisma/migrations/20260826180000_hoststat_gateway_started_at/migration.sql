-- The gateway process's boot time, reported on the 30s host-stat push.
-- Null until each machine's gateway next restarts on code that sends it.
ALTER TABLE "HostStat" ADD COLUMN "gatewayStartedAt" TIMESTAMP(3);
