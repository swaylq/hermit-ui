export async function register() {
  // Cron scheduling now lives entirely in the Mac gateway (cron-runner.ts),
  // driven by the gateway's tick loop. The dashboard schedules nothing — this
  // Next.js instrumentation hook is intentionally a no-op.
}
