-- Pure-chat sessions: read-only tool surface, decided at spawn time.
ALTER TABLE "ChatSession" ADD COLUMN "chatOnly" BOOLEAN NOT NULL DEFAULT false;
