-- The orchestrator's machine-managed-template version stamp. ensureBrain
-- re-overlays the `dreaming` skill + re-stamps this when it's behind
-- BRAIN_TEMPLATE_VERSION, so an old brain converges on gateway startup.
-- Additive; 0 = pre-versioning / non-brain.
ALTER TABLE "Agent" ADD COLUMN "brainTemplateVersion" INTEGER NOT NULL DEFAULT 0;
