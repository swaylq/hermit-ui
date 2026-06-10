-- Dedup key for gateway-synced ChatMessage rows.
--
-- Backfill is a no-op: a production scan (2026-06-10) found 0 duplicate
-- (sessionId, externalId) groups across 26,907 rows; 514 rows have a NULL
-- externalId (user-composed), which stay distinct under Postgres unique-index
-- NULL semantics. Turns the chat-message sync dedup into an index point-lookup
-- instead of a per-session heap scan that went O(n^2) during reconnect-flush
-- floods and produced the /api/sync/chat-message 502/timeout storms.
CREATE UNIQUE INDEX "ChatMessage_sessionId_externalId_key" ON "ChatMessage"("sessionId", "externalId");
