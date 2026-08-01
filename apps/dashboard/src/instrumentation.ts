// Runs once when the Next server boots — the custom server included, since
// server.ts calls app.prepare() and that is what triggers this hook. The place for
// work that has to happen whether or not anyone has opened a page.
//
// Cron scheduling used to live here and now lives entirely in the Mac gateway
// (cron-runner.ts). What's left is the one check that must NOT live on a gateway: a
// gateway that is down or wedged is a cause of unanswered messages, so the watcher
// for them belongs on the side that stays up. See docs/unanswered-alert-design.md.

export async function register() {
  // Node runtime only — the Edge runtime has no DB client and no timers to keep.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startUnansweredSweep } = await import('@/server/unanswered');
  startUnansweredSweep();
}
