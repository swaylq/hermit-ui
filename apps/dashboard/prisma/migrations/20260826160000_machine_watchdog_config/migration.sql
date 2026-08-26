-- Per-machine watchdog configuration (Settings → Watchdogs). One JSON column,
-- same shape as backendsConfig: whole-object replace, server-validated, and
-- polled by the gateway (machines.pollWatchdogConfig). Additive: every reader
-- falls back to the built-in defaults when the column is null.
ALTER TABLE "Machine" ADD COLUMN "watchdogConfig" JSONB;
