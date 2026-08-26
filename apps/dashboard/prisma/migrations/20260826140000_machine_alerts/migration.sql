-- Machine-health alerts: one open row per (machine, kind), raised by the
-- stuck-message sweep (server/machine-alerts.ts), the on-host gateway watchdog
-- (scripts/gateway-watch.sh), or a gateway tick that had to act (stray-reaper).
--
-- Additive: the sweep and the banner are the only readers, and both tolerate an
-- empty table — a deploy that runs the migration without the new code simply
-- never raises anything.
CREATE TABLE "MachineAlert" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "pushedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MachineAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MachineAlert_machineId_kind_resolvedAt_idx" ON "MachineAlert"("machineId", "kind", "resolvedAt");

ALTER TABLE "MachineAlert" ADD CONSTRAINT "MachineAlert_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
