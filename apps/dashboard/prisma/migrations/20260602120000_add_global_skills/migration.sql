-- CreateTable
CREATE TABLE "GlobalSkill" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT,
    "refs" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "isBundle" BOOLEAN NOT NULL DEFAULT false,
    "subSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "metadataAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalSkillRequest" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "content" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "GlobalSkillRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlobalSkill_machineId_name_key" ON "GlobalSkill"("machineId", "name");

-- CreateIndex
CREATE INDEX "GlobalSkillRequest_machineId_status_idx" ON "GlobalSkillRequest"("machineId", "status");

-- AddForeignKey
ALTER TABLE "GlobalSkill" ADD CONSTRAINT "GlobalSkill_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalSkillRequest" ADD CONSTRAINT "GlobalSkillRequest_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
