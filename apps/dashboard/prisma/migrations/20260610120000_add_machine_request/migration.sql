-- Machine-level ops queued by the dashboard for the gateway to run on its host
-- (upgrade Claude Code, restart all sessions). Mirrors AgentRequest / GlobalSkillRequest.

-- CreateTable
CREATE TABLE "MachineRequest" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "output" TEXT,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MachineRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MachineRequest_machineId_status_idx" ON "MachineRequest"("machineId", "status");

-- AddForeignKey
ALTER TABLE "MachineRequest" ADD CONSTRAINT "MachineRequest_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
