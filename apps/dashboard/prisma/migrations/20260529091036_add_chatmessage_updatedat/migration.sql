-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_updatedAt_idx" ON "ChatMessage"("sessionId", "updatedAt");
