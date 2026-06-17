-- Per-session "hidden" stamp — the user hides a noisy chat from the sidebar
-- recents list. Purely a UI filter (the session keeps running); a "show hidden"
-- toggle reveals them. Server-side (not localStorage) so a hide syncs across
-- devices, matching lastReadAt. Additive, nullable.
ALTER TABLE "ChatSession" ADD COLUMN "hiddenAt" TIMESTAMP(3);
