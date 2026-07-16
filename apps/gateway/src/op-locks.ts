// One owner for the gateway's per-key re-entrancy guards.
//
// Several long-running operations are driven by setInterval ticks that DON'T await
// each other, so an operation that takes longer than its interval would be re-entered
// for the same key by the next tick — double-killing a pane, double-firing a cron,
// double-spawning a claude. Each such operation used to keep its own module-level
// Set with hand-rolled has/add/delete scattered across chat-runner.ts and
// cron-runner.ts; this centralizes them so the lifecycle — and the guarantee that a
// lock is released on every exit path — lives in one place.
//
// Non-blocking BY DESIGN: tryAcquire returns false instead of waiting, and the caller
// SKIPS this tick (the row stays queued / is retried next tick). The pollers are
// single-threaded tick loops — a blocking lock would stall every other session.
//
// Lock kinds and their keys:
//   setup / restart / hibernate → keyed by chat sessionId (the three per-session ops)
//   cron                        → keyed by cronId (a cron must not fire while its
//                                 previous run is still in flight)
//
// NOTE: this owns *operation re-entrancy* only. The session STATE store
// (`sessionStates` in chat-runner) and the pinned-transcript set (`pinnedUuids` in
// cron-runner) are data, not concurrency guards, and deliberately stay where they are.
//
// This module intentionally keeps each kind independent (it preserves the exact prior
// semantics). Because all four now share one owner, cross-operation mutual exclusion
// (e.g. block a restart while a hibernate holds the same session) becomes a one-line
// change here — but that's a behaviour change that needs runtime soak to prove safe,
// so it's left off for now.

export type LockKind = 'setup' | 'restart' | 'hibernate' | 'cron';

const held: Record<LockKind, Set<string>> = {
  setup: new Set(),
  restart: new Set(),
  hibernate: new Set(),
  cron: new Set(),
};

/**
 * Try to take the lock for (kind, key). Returns true if acquired — the caller then
 * OWNS it and must `release` on every exit path (use try/finally). Returns false if
 * it's already held, in which case the caller should skip this tick.
 */
export function tryAcquire(kind: LockKind, key: string): boolean {
  const set = held[kind];
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

/** Release a lock taken with tryAcquire. Idempotent (releasing an unheld key is a no-op). */
export function release(kind: LockKind, key: string): void {
  held[kind].delete(key);
}

/**
 * Is (kind, key) currently locked? For a poller that wants to SKIP a key another
 * operation is mid-flight on, without taking the lock itself.
 */
export function isLocked(kind: LockKind, key: string): boolean {
  return held[kind].has(key);
}
