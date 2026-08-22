// Where a block's translation should be fetched from — the one decision the
// two-tier cache turns on, pulled out so it can be pinned by tests instead of
// only ever exercised through IndexedDB.
//
// The tiers exist because `getTranslation` is called during render and cannot
// await: the in-memory map is the synchronous read path, and IndexedDB sits
// behind it so a reload does not re-buy every translation on screen.
//
// The rule that matters is DISK BEFORE NETWORK, EXACTLY ONCE. A key that has
// never been looked for on disk goes to disk even though the network would also
// answer it — paying for something already cached is the whole thing this
// avoids. A key that has already been looked for goes straight to the network,
// because the answer to "is it on disk" does not change within a page load: a
// miss stays a miss until something writes it, and whatever writes it also puts
// it in memory, where this function sees it as `known`.

export type KeyState = {
  /** Already in the in-memory map. */
  known: boolean;
  /** Asked for and refused (a gate rejection, a provider error). Not retried. */
  failed: boolean;
  /** A network request carrying this key is in flight. */
  inflight: boolean;
  /** Sitting in the disk-lookup batch. */
  diskPending: boolean;
  /** Sitting in the network batch. */
  queued: boolean;
  /** Disk has already been consulted for this key during this page load. */
  diskAsked: boolean;
};

export type Route = 'skip' | 'disk' | 'net';

export function routeKey(s: KeyState): Route {
  if (s.known || s.failed || s.inflight || s.diskPending || s.queued) return 'skip';
  return s.diskAsked ? 'net' : 'disk';
}

/** Nothing is happening to this key — the state a fresh block starts in. */
export const IDLE: KeyState = {
  known: false,
  failed: false,
  inflight: false,
  diskPending: false,
  queued: false,
  diskAsked: false,
};
