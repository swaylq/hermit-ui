-- The machine orchestrator ("义脑" / brain) flag on Agent. Additive. At most one
-- true per machine is enforced in application code (agents.setOrchestrator), not
-- by a DB constraint.
ALTER TABLE "Agent" ADD COLUMN "isOrchestrator" BOOLEAN NOT NULL DEFAULT false;
