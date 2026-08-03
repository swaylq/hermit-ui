-- Cost with the cache reads priced out, per agent per day.
-- Defaults to 0; the gateway's next run (~30 min) rewrites the whole window anyway,
-- so no backfill is needed and none would be honest — the split is derived from the
-- per-model breakdown that only the collector sees.
ALTER TABLE "UsageHourly" ADD COLUMN "costExCacheRead" DOUBLE PRECISION NOT NULL DEFAULT 0;
