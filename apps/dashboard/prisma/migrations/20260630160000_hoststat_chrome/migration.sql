-- Per-agent Chrome footprint accounting on HostStat (resource governance).
-- Additive, nullable columns — safe to apply online (no table rewrite/lock).
ALTER TABLE "HostStat" ADD COLUMN "chromeCount" INTEGER;
ALTER TABLE "HostStat" ADD COLUMN "chromeRssMb" INTEGER;
