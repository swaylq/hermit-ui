-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "lastAssistantText" TEXT,
ADD COLUMN     "lastUserPrompt" TEXT,
ADD COLUMN     "snapshotAt" TIMESTAMP(3);
