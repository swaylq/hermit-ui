-- Widen usage token counters from INT4 to INT8. Under prompt caching the gateway's
-- per-hour aggregate of cacheReadTokens (the whole cached context is re-read every
-- turn) exceeds 2,147,483,647 — the signed 32-bit max — so usageHourly.upsert() and
-- usageWindow.upsert() threw a conversion error and the usage sync 500'd every ~30 min.
-- BIGINT holds these comfortably. int4 -> int8 is a lossless widening.
ALTER TABLE "UsageHourly"
  ALTER COLUMN "inputTokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "outputTokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cacheCreationTokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cacheReadTokens" SET DATA TYPE BIGINT;

ALTER TABLE "UsageWindow"
  ALTER COLUMN "totalTokens" SET DATA TYPE BIGINT;
