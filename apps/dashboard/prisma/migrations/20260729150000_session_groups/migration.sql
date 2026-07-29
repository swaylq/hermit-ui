-- Collapsible groups for the sidebar's session list.
--
-- The list is recency-ordered — right for "what was I just doing", wrong for 70 open
-- sessions, and made worse by cron mailboxes bumping themselves to the top on every
-- report. A group folds sessions away without giving up the flat list: a grouped
-- session leaves the recents, an ungrouped one stays exactly where it was.
--
-- Collapsed state is stored per group rather than per browser, so the same person on
-- a phone and a laptop sees the same drawers shut.

CREATE TABLE "SessionGroup" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "collapsed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SessionGroup_machineId_sortOrder_idx" ON "SessionGroup" ("machineId", "sortOrder");

ALTER TABLE "SessionGroup" ADD CONSTRAINT "SessionGroup_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: deleting a drawer must not delete the conversations in it.
ALTER TABLE "ChatSession" ADD COLUMN "groupId" TEXT;

ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "SessionGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ChatSession_groupId_idx" ON "ChatSession" ("groupId");
