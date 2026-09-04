-- Idempotency key for user-composed ChatMessage rows.
--
-- Lets a client retry a `chat.send` it never saw the answer to (the iOS outbox
-- replaying once the network is back) without posting the message twice: the
-- retry carries the same clientId and gets the first call's row back.
--
-- Backfill is a no-op — the column is NULL on every existing row, and Postgres
-- treats NULLs as distinct under a unique index, so nothing can collide today.
-- The browser composer never sets a clientId either, so the index stays
-- effectively empty until the iOS outbox ships.
--
-- Deploy note: CREATE UNIQUE INDEX takes a SHARE lock on ChatMessage, which
-- blocks writes to the table (not reads) while the index builds. That's one
-- full scan of the largest table in this database, so deploy it at a quiet
-- moment rather than mid-conversation.
ALTER TABLE "ChatMessage" ADD COLUMN "clientId" TEXT;

CREATE UNIQUE INDEX "ChatMessage_sessionId_clientId_key" ON "ChatMessage"("sessionId", "clientId");
