-- The auto title is derived from the USER's messages, so the "is it stale?"
-- counter has to be measured in the same unit.
--
-- titleMsgCount counted every row in the session — overwhelmingly tool traffic,
-- which the title never reads. Replacing rather than renaming: the old values
-- are total counts and would be nonsense compared against a user-message count
-- (far too large, so no session would ever refresh again). NULL means "titled
-- before we tracked this", which the refresh gate already treats as due.
ALTER TABLE "ChatSession" DROP COLUMN "titleMsgCount";
ALTER TABLE "ChatSession" ADD COLUMN "titleUserMsgCount" INTEGER;
