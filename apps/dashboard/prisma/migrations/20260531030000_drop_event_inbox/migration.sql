-- Drop the Event "inbox" subsystem (happy-push.sh → /api/push → Event,
-- displayed only in the agent-detail "recent events" section). Dormant since
-- the 2026-05-22 switch to the happy iOS app; the whole chain was removed.

-- DropForeignKey
ALTER TABLE "Event" DROP CONSTRAINT "Event_machineId_fkey";

-- DropForeignKey
ALTER TABLE "Event" DROP CONSTRAINT "Event_agentId_fkey";

-- DropTable
DROP TABLE "Event";
