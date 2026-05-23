-- CreateTable
CREATE TABLE "SystemTask" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "directory" TEXT,
    "prompt" TEXT NOT NULL,
    "intervalSec" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "happySessionId" TEXT,
    "lastFire" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastOutput" TEXT,
    "lastDurationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemTask_machineId_agentName_idx" ON "SystemTask"("machineId", "agentName");

-- CreateIndex
CREATE UNIQUE INDEX "SystemTask_machineId_name_key" ON "SystemTask"("machineId", "name");

-- AddForeignKey
ALTER TABLE "SystemTask" ADD CONSTRAINT "SystemTask_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
