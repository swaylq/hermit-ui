-- CreateTable
CREATE TABLE "PlanUsage" (
    "machineId" TEXT NOT NULL,
    "sessionPct" INTEGER,
    "weekPct" INTEGER,
    "weekSonnetPct" INTEGER,
    "sessionResetText" TEXT,
    "weekResetText" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanUsage_pkey" PRIMARY KEY ("machineId")
);

-- AddForeignKey
ALTER TABLE "PlanUsage" ADD CONSTRAINT "PlanUsage_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
