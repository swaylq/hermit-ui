-- Toggle whether agents load the global memory. off = gateways remove the
-- managed block from ~/.claude/CLAUDE.md (content is kept in the DB).
ALTER TABLE "GlobalMemory" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
