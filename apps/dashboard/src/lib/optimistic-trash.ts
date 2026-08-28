'use client';

// Tombstones for an optimistic trash whose navigation is still in flight.
//
// The sidebar's delete removes the session from the listSessions cache the
// moment the user confirms (recent-lists.tsx). If that session is the one in
// the URL, the chat page's stale-id check (chat/page.tsx) sees "id not in
// list" within the same beat and — historically — hard-navs away with
// window.location, white-screening the page before the sidebar's SPA
// router.replace to the next session can land. Marking the id here lets the
// stale check defer to the SPA navigation; the TTL bounds the lie if the
// mutation is rolled back or the marker is never consumed.

const tombstones = new Map<string, number>(); // session id → marked-at ms
const TTL_MS = 5000;

export function markOptimisticTrash(id: string): void {
  tombstones.set(id, Date.now());
}

export function isOptimisticTrash(id: string): boolean {
  const t = tombstones.get(id);
  if (t === undefined) return false;
  if (Date.now() - t > TTL_MS) {
    tombstones.delete(id);
    return false;
  }
  return true;
}

export function clearOptimisticTrash(id: string): void {
  tombstones.delete(id);
}
