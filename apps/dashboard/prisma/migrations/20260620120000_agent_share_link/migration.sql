-- A per-agent share link: a scoped credential granting access to only one agent.
-- The token is bcrypt-hashed (keyHash) with an indexed keyPrefix for fast lookup,
-- mirroring Machine. One active link per (machineId, agentName); revoke deletes
-- the row, regenerate overwrites the hash.
CREATE TABLE "AgentShareLink" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    CONSTRAINT "AgentShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentShareLink_machineId_agentName_key" ON "AgentShareLink"("machineId", "agentName");

-- CreateIndex
CREATE INDEX "AgentShareLink_keyPrefix_idx" ON "AgentShareLink"("keyPrefix");

-- AddForeignKey
ALTER TABLE "AgentShareLink" ADD CONSTRAINT "AgentShareLink_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
