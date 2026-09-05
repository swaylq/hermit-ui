-- The codex model catalogue this machine's CLI keeps in models_cache.json,
-- plus the model that machine's gateway resolves when a session pins none.
-- Read by the chat header's model chip, which until now was Claude Code only.
-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "codexModels" JSONB;
