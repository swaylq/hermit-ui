-- CreateTable
CREATE TABLE "AgentRequest" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "persona" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRequest_machineId_status_idx" ON "AgentRequest"("machineId", "status");

-- AddForeignKey
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
