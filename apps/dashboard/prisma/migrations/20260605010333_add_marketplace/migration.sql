-- GlobalSkill: marketplace provenance
ALTER TABLE "GlobalSkill" ADD COLUMN "marketSkillId" TEXT;
ALTER TABLE "GlobalSkill" ADD COLUMN "marketVersion" TEXT;

-- MarketSkill (fleet-global)
CREATE TABLE "MarketSkill" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT,
  "origin" TEXT NOT NULL DEFAULT 'uploaded',
  "originUrl" TEXT,
  "category" TEXT,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "latestVersion" TEXT NOT NULL,
  "publishedByMachineId" TEXT,
  "publishedByAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketSkill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketSkill_slug_key" ON "MarketSkill"("slug");

-- MarketSkillVersion
CREATE TABLE "MarketSkillVersion" (
  "id" TEXT NOT NULL,
  "marketSkillId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "changelog" TEXT,
  "content" TEXT,
  "refs" JSONB NOT NULL DEFAULT '[]',
  "fileCount" INTEGER NOT NULL DEFAULT 0,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByMachineId" TEXT,
  CONSTRAINT "MarketSkillVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketSkillVersion_marketSkillId_version_key" ON "MarketSkillVersion"("marketSkillId", "version");
ALTER TABLE "MarketSkillVersion" ADD CONSTRAINT "MarketSkillVersion_marketSkillId_fkey" FOREIGN KEY ("marketSkillId") REFERENCES "MarketSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MarketTemplate (fleet-global)
CREATE TABLE "MarketTemplate" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT,
  "basePersona" TEXT,
  "origin" TEXT NOT NULL DEFAULT 'uploaded',
  "publishedByMachineId" TEXT,
  "sourceAgent" TEXT,
  "latestVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketTemplate_slug_key" ON "MarketTemplate"("slug");

-- MarketTemplateVersion
CREATE TABLE "MarketTemplateVersion" (
  "id" TEXT NOT NULL,
  "marketTemplateId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "changelog" TEXT,
  "files" JSONB NOT NULL DEFAULT '[]',
  "includedSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketTemplateVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketTemplateVersion_marketTemplateId_version_key" ON "MarketTemplateVersion"("marketTemplateId", "version");
ALTER TABLE "MarketTemplateVersion" ADD CONSTRAINT "MarketTemplateVersion_marketTemplateId_fkey" FOREIGN KEY ("marketTemplateId") REFERENCES "MarketTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AgentSkillInstall (agent-level install provenance)
CREATE TABLE "AgentSkillInstall" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "skillName" TEXT NOT NULL,
  "marketSkillId" TEXT NOT NULL,
  "marketVersion" TEXT NOT NULL,
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentSkillInstall_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentSkillInstall_machineId_agentName_skillName_key" ON "AgentSkillInstall"("machineId", "agentName", "skillName");
