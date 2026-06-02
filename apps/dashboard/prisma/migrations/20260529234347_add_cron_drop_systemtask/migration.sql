-- DropForeignKey
ALTER TABLE "LaunchAgentRecord" DROP CONSTRAINT "LaunchAgentRecord_machineId_fkey";

-- DropForeignKey
ALTER TABLE "SystemTask" DROP CONSTRAINT "SystemTask_machineId_fkey";

-- DropTable
DROP TABLE "LaunchAgentRecord";

-- DropTable
DROP TABLE "SystemTask";

-- CreateTable
CREATE TABLE "Cron" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "directory" TEXT,
    "title" TEXT,
    "prompt" TEXT NOT NULL,
    "intervalSec" INTEGER NOT NULL,
    "jitterSec" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFire" TIMESTAMP(3),
    "nextFire" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cron_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronRun" (
    "id" TEXT NOT NULL,
    "cronId" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "output" TEXT,
    "durationMs" INTEGER,
    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cron_machineId_agentName_idx" ON "Cron"("machineId", "agentName");

-- CreateIndex
CREATE INDEX "CronRun_cronId_firedAt_idx" ON "CronRun"("cronId", "firedAt");

-- AddForeignKey
ALTER TABLE "Cron" ADD CONSTRAINT "Cron_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CronRun" ADD CONSTRAINT "CronRun_cronId_fkey" FOREIGN KEY ("cronId") REFERENCES "Cron"("id") ON DELETE CASCADE ON UPDATE CASCADE;
