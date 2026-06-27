-- Red-pressure alert state on HostStat (A4). redAlertAt = set on red crossing,
-- cleared on recovery; alertReadAt = set when the inbox is read. Both additive.
ALTER TABLE "HostStat" ADD COLUMN "redAlertAt" TIMESTAMP(3);
ALTER TABLE "HostStat" ADD COLUMN "alertReadAt" TIMESTAMP(3);
