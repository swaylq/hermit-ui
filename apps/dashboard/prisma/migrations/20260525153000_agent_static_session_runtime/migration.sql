-- Refactor: agent = static folder · session = runtime
-- Moves pid/alive/state/contextTokens/outputTokens/lastActivity/transcriptPath/
-- lastUserPrompt/lastAssistantText/snapshotAt from Agent to ChatSession.
-- Drops obsolete agent-level restart fields (P2 moved restart to ChatSession).

-- ChatSession gains runtime columns
ALTER TABLE "ChatSession"
  ADD COLUMN "pid" INTEGER,
  ADD COLUMN "alive" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "contextTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "lastActivity" TIMESTAMP(3),
  ADD COLUMN "transcriptPath" TEXT,
  ADD COLUMN "lastUserPrompt" TEXT,
  ADD COLUMN "lastAssistantText" TEXT,
  ADD COLUMN "snapshotAt" TIMESTAMP(3);

-- Agent loses runtime columns
ALTER TABLE "Agent"
  DROP COLUMN "pid",
  DROP COLUMN "alive",
  DROP COLUMN "state",
  DROP COLUMN "contextTokens",
  DROP COLUMN "outputTokens",
  DROP COLUMN "lastActivity",
  DROP COLUMN "transcriptPath",
  DROP COLUMN "lastUserPrompt",
  DROP COLUMN "lastAssistantText",
  DROP COLUMN "snapshotAt",
  DROP COLUMN "restartRequestedAt",
  DROP COLUMN "restartStartedAt";

-- Agent gains static-metadata columns
ALTER TABLE "Agent"
  ADD COLUMN "directory" TEXT,
  ADD COLUMN "identityText" TEXT,
  ADD COLUMN "userText" TEXT,
  ADD COLUMN "agentsText" TEXT,
  ADD COLUMN "toolsText" TEXT,
  ADD COLUMN "evolutionLessons" TEXT,
  ADD COLUMN "skillNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "memorySummary" TEXT,
  ADD COLUMN "metadataAt" TIMESTAMP(3);
