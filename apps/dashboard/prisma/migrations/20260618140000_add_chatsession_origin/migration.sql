-- Structural origin marker for a chat session: 'dispatch' = created by Brain's
-- MCP `dispatch` tool (one-shot delegation to another agent); NULL = a normal
-- user-opened chat. The /brain/dispatch page filters on this instead of the
-- "Brain →" title prefix, so a dispatch with a custom title is no longer
-- mistaken for a user chat and dropped from the list. Additive, nullable.
ALTER TABLE "ChatSession" ADD COLUMN "origin" TEXT;
