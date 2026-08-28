-- Store the two quota slots separately and retain which metered bucket each
-- came from. Existing single-window columns stay for rolling compatibility.
ALTER TABLE "CodexUsage"
ADD COLUMN "fiveHourPct" DOUBLE PRECISION,
ADD COLUMN "fiveHourResetsAt" TIMESTAMP(3),
ADD COLUMN "fiveHourLimitId" TEXT,
ADD COLUMN "fiveHourLimitName" TEXT,
ADD COLUMN "weekPct" DOUBLE PRECISION,
ADD COLUMN "weekResetsAt" TIMESTAMP(3),
ADD COLUMN "weekLimitId" TEXT,
ADD COLUMN "weekLimitName" TEXT;
