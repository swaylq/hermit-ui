-- DropIndex
DROP INDEX IF EXISTS "ChatSession_groupId_idx";

-- DropIndex
DROP INDEX IF EXISTS "Cron_reportSessionId_idx";

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "piConfig" JSONB;
