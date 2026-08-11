-- Settings → Backends: which backends a machine offers.
-- Nullable with no default: absent means "everything this build knows about",
-- so existing machines keep every backend without a data backfill.
ALTER TABLE "Machine" ADD COLUMN "backendsConfig" JSONB;

-- Codex plan consumption, collected from codex's own rollout files.
CREATE TABLE "CodexUsage" (
    "machineId" TEXT NOT NULL,
    "usedPercent" DOUBLE PRECISION,
    "windowMinutes" INTEGER,
    "resetsAt" TIMESTAMP(3),
    "planType" TEXT,
    "daily" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodexUsage_pkey" PRIMARY KEY ("machineId")
);

ALTER TABLE "CodexUsage" ADD CONSTRAINT "CodexUsage_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
