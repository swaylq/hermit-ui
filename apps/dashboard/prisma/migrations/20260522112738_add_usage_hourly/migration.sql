-- CreateTable
CREATE TABLE "UsageHourly" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "hourBucket" TIMESTAMP(3) NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageHourly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageHourly_machineId_hourBucket_idx" ON "UsageHourly"("machineId", "hourBucket");

-- CreateIndex
CREATE UNIQUE INDEX "UsageHourly_machineId_agentName_hourBucket_key" ON "UsageHourly"("machineId", "agentName", "hourBucket");

-- AddForeignKey
ALTER TABLE "UsageHourly" ADD CONSTRAINT "UsageHourly_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
