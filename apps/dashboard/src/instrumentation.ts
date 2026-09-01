// Runs once when the Next server boots — the custom server included, since
// server.ts calls app.prepare() and that is what triggers this hook. The place for
// work that has to happen whether or not anyone has opened a page.
//
// Cron scheduling used to live here and now lives entirely in the Mac gateway
// (cron-runner.ts). What's left is the checks that must NOT live on a gateway: a
// gateway that is down or wedged is a cause of unanswered and undelivered
// messages, so the watchers for them belong on the side that stays up. See
// docs/unanswered-alert-design.md.

export async function register() {
  // Node runtime only — the Edge runtime has no DB client and no timers to keep.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startUnansweredSweep } = await import('@/server/unanswered');
  startUnansweredSweep();
  const { startStuckMessageSweep } = await import('@/server/machine-alerts');
  startStuckMessageSweep();
  // Same argument, third case: a gateway that dies mid-run is the reason a CronRun
  // is stuck at 'running' forever, so the thing that notices cannot live on it.
  const { startStaleCronRunSweep } = await import('@/server/cron-sweep');
  startStaleCronRunSweep();
}
