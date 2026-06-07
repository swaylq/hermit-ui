// Skill install / uninstall / update apply on the gateway ASYNCHRONOUSLY: the
// dashboard queues a request, the gateway polls it (~every 3s), mutates the
// agent's files on disk, then re-syncs the agent row. So an invalidate fired the
// instant the mutation returns refetches PRE-change data — the view wouldn't show
// the new/removed skill until the detail's 30s poll. Re-run the invalidation a
// few times across the gateway's apply+sync window so the view catches up within
// a few seconds. It only triggers refetches (no cache writes), so an early hit
// that lands before the change is harmless — a later hit catches it.
export function pollInvalidate(fn: () => void, delays: number[] = [2000, 5000, 9000]): void {
  fn();
  for (const ms of delays) setTimeout(fn, ms);
}
