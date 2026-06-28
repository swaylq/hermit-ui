-- Denormalized sidebar preview for ChatSession: the first user message's first
-- text block (whitespace-collapsed, ≤120 chars). Additive + nullable, so this
-- can't fail and needs no backfill at DDL time — existing rows get NULL and are
-- populated by a one-time JS backfill (robust against malformed content) right
-- after deploy; new sessions get it from chat.send. listSessions / getSession
-- then read this column instead of a per-session first-user-message subquery
-- (~0.5–0.9s for 40 sessions).
ALTER TABLE "ChatSession" ADD COLUMN "preview" TEXT;
