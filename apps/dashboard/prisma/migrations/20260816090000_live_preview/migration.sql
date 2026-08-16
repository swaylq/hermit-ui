-- Live preview: agent-mounted HTML dir / loopback service, shown in the chat
-- pane's preview panel. Written by /api/sync/live-preview (gateway), read by
-- chat.getSession only.
ALTER TABLE "ChatSession" ADD COLUMN "livePreview" JSONB;
