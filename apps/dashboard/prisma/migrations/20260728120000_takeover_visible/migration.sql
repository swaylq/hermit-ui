-- Make the Brain's actions visible while it drives a conversation.
--
-- takeoverDraft: what it is composing right now. The composer renders it ghosted
-- before the message is sent, so a Brain turn arrives as something you watched
-- happen — and those seconds are the window to take the wheel back.
ALTER TABLE "ChatSession" ADD COLUMN "takeoverDraft" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "takeoverDraftAt" TIMESTAMP(3);

-- answeredBy: who resolved a permission / question card. NULL = the human clicked
-- it (every existing row, correctly). A choice the Brain made on your behalf should
-- not be indistinguishable from one you made yourself.
ALTER TABLE "Interaction" ADD COLUMN "answeredBy" TEXT;
