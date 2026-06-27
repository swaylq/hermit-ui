-- Host resource governance (docs/resource-governance-design.md): per-session RSS +
-- hibernation lifecycle on ChatSession, idle-reap config on Machine, and a HostStat
-- latest-snapshot table. All additive; safe on a live DB.

-- ChatSession: per-session memory + hibernation lifecycle
ALTER TABLE "ChatSession" ADD COLUMN "rssMb" INTEGER;
ALTER TABLE "ChatSession" ADD COLUMN "hibernatedAt" TIMESTAMP(3);
ALTER TABLE "ChatSession" ADD COLUMN "hibernateRequestedAt" TIMESTAMP(3);

-- Machine: reaper idle-TTL. Seed existing machines to 72h (the approved default);
-- null = auto-reap disabled.
ALTER TABLE "Machine" ADD COLUMN "idleReapHours" INTEGER;
UPDATE "Machine" SET "idleReapHours" = 72 WHERE "idleReapHours" IS NULL;

-- HostStat: one latest-snapshot row per machine (RAM / swap / load / cpu).
CREATE TABLE "HostStat" (
    "machineId" TEXT NOT NULL,
    "ramTotalMb" INTEGER,
    "ramFreeMb" INTEGER,
    "swapUsedMb" INTEGER,
    "swapTotalMb" INTEGER,
    "loadAvg1" DOUBLE PRECISION,
    "cpuCount" INTEGER,
    "sampledAt" TIMESTAMP(3),
    CONSTRAINT "HostStat_pkey" PRIMARY KEY ("machineId")
);

-- AddForeignKey
ALTER TABLE "HostStat" ADD CONSTRAINT "HostStat_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
