-- Brain takeover: the human hands a normal conversation to the Brain, which then
-- talks to the agent on their behalf. See docs/brain-takeover-design.md.
--
-- Unlike a dispatch (which OPENS a session on a target agent), a takeover joins a
-- conversation the human was already having — so ChatSession.origin stays null and
-- their own messages stay in place. takeoverBySessionId doubles as the live flag
-- and as the Brain session to poke, mirroring dispatchedBySessionId.

ALTER TABLE "ChatSession" ADD COLUMN "takeoverBySessionId" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "takeoverStartedAt" TIMESTAMP(3);
ALTER TABLE "ChatSession" ADD COLUMN "takeoverTurns" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatSession" ADD COLUMN "takeoverGoal" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "takeoverNotify" TEXT;

-- Provenance for role='user' rows: NULL = the human typed it, 'brain' = the Brain
-- said it during a takeover. Every existing row is NULL, i.e. human — correct, since
-- takeovers didn't exist before this migration.
ALTER TABLE "ChatMessage" ADD COLUMN "authoredBy" TEXT;

-- Backs the gateway's takeover-watcher poll (every ~2s), same shape as the four
-- existing sparse request-flag partial indexes.
CREATE INDEX "ChatSession_takeover_partial_idx"
  ON "ChatSession" ("takeoverBySessionId")
  WHERE "takeoverBySessionId" IS NOT NULL;

-- Backs the USER.md corpus scan (chat.humanMessages): machine-wide, time-ordered,
-- "everything the human typed since <watermark>". Partial on exactly the rows that
-- qualify, so it stays a small fraction of ChatMessage (on the reference machine,
-- human-typed rows are ~1% of 190k+ messages — the rest are assistant/tool traffic).
CREATE INDEX "ChatMessage_human_corpus_idx"
  ON "ChatMessage" ("createdAt")
  WHERE "role" = 'user' AND "authoredBy" IS NULL;
