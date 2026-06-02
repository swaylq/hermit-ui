-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "skills" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "AgentRequest" ADD COLUMN     "content" TEXT,
ADD COLUMN     "target" TEXT;
