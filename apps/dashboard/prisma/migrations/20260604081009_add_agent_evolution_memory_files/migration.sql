-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "evolutionFiles" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Agent" ADD COLUMN "memoryFiles" JSONB NOT NULL DEFAULT '[]';
