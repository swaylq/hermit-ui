-- Session titles gained provenance.
--
-- `title` alone can't answer the two questions the auto-titler has to ask:
-- "did a human choose this?" (never overwrite it) and "has the conversation
-- moved on far enough since I last looked?" (otherwise every session open
-- would spend a model call re-deriving the same title).
--
-- Existing rows: any title present today was typed by a user or set through
-- chat.setTitle, so titleAuto defaults to false and they are left alone.
ALTER TABLE "ChatSession" ADD COLUMN "titleAuto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatSession" ADD COLUMN "titleMsgCount" INTEGER;
