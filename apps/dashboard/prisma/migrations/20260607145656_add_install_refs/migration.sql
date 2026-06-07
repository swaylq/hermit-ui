-- Install bundles carry sub-files ([{ path, content }]) so the gateway can write
-- a skill's whole tree (SKILL.md + cli scripts / sub-skills), not just SKILL.md.
ALTER TABLE "AgentRequest" ADD COLUMN "refs" JSONB;
ALTER TABLE "GlobalSkillRequest" ADD COLUMN "refs" JSONB;
