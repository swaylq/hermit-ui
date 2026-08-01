-- Unanswered-message alert: the newest message in a conversation is one the HUMAN
-- typed, and nothing answered it. See docs/unanswered-alert-design.md.
--
-- Both columns are NULL for every existing row, which is the correct starting state:
-- "not currently flagged". The first sweep after deploy raises whatever is genuinely
-- stalled right now (on the reference machine that is exactly one session — a 06-30
-- question that was never answered at all).

ALTER TABLE "ChatSession" ADD COLUMN "unansweredMsgId" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "unansweredAckedMsgId" TEXT;

-- Backs notifications.feed / notifications.counts, which run on the always-on 5s
-- browser poll and must not scan the session table to learn that nothing is stalled.
-- Partial, so in the normal (empty) case the index is a single page.
CREATE INDEX "ChatSession_unanswered_partial_idx"
  ON "ChatSession" ("machineId")
  WHERE "unansweredMsgId" IS NOT NULL;
