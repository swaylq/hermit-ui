-- UsageWindow keeps the token split, not just the total.
-- 96% of a window's tokens are cache reads (the same context re-counted every turn),
-- so the total alone reads as far more activity than actually happened. Defaults are
-- 0: existing rows are refreshed by the gateway's next push (~30 min).
ALTER TABLE "UsageWindow"
  ADD COLUMN "inputTokens"         BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "outputTokens"        BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "cacheCreationTokens" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "cacheReadTokens"     BIGINT NOT NULL DEFAULT 0;
