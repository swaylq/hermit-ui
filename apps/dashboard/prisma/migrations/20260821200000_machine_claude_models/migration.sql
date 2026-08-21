-- The Claude Code model catalogue this machine's CLI reports
-- (supportedModels()), cached for the chat model picker.
-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "claudeModels" JSONB;
