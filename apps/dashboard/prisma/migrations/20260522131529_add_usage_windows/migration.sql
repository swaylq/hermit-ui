-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "fiveHourLimitUsd" DOUBLE PRECISION,
ADD COLUMN     "weeklyLimitUsd" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "UsageWindow" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "costUSD" DOUBLE PRECISION NOT NULL,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageWindow_machineId_idx" ON "UsageWindow"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageWindow_machineId_kind_key" ON "UsageWindow"("machineId", "kind");

-- AddForeignKey
ALTER TABLE "UsageWindow" ADD CONSTRAINT "UsageWindow_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
