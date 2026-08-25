-- Kimi Code subscription quota, one row per machine (see schema.prisma).
--
-- Additive: nothing reads or writes this until a gateway that knows about it
-- restarts, and a machine with no Kimi credential simply never gets a row —
-- which is what lets the Usage page hide the panel rather than render an empty
-- one.
CREATE TABLE "KimiUsage" (
    "machineId" TEXT NOT NULL,
    "credentialId" TEXT,
    "planLevel" TEXT,
    "planName" TEXT,
    "periodUsed" INTEGER,
    "periodLimit" INTEGER,
    "periodResetsAt" TIMESTAMP(3),
    "windows" JSONB,
    "parallelLimit" INTEGER,
    "extraBalanceCents" INTEGER,
    "extraCurrency" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KimiUsage_pkey" PRIMARY KEY ("machineId")
);

ALTER TABLE "KimiUsage" ADD CONSTRAINT "KimiUsage_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
