// runtime/turn-boundary.ts — "this session just started or just finished a
// turn", announced the instant the backend knows it.
//
// Why this exists: the dashboard learned a session's state ONLY from the 8s
// snapshot tick, which the browser then polls at 5s — so a turn boundary took
// up to 13s to reach the screen. Everything the chat page put on top of that to
// cover the gap was a guess (the send stamp, "the tail bubble grew in the last
// 1.8s"), and a guess that lapses mid-turn is exactly what made the status chip
// read working → ready → working on a single send.
//
// The claude-sdk runtime already holds the authoritative boundary — the CLI's
// `session_state_changed` frame — so the fix is transport, not detection: fire
// here, and the pusher turns it into one tiny UPDATE within ~150ms.
//
// Deliberately a plain module-level listener list rather than an EventEmitter:
// there is exactly one subscriber (the pusher, wired in index.ts), the payload
// is already computed by the caller, and a missed notification is not a
// correctness problem — the 8s snapshot still lands underneath it.

export interface TurnBoundary {
  sessionId: string;
  /** The runtime's own `isWorking` verdict at this instant. */
  working: boolean;
  /** `RuntimeActivity | null`, already narrowed by the runtime. */
  activity: unknown;
}

type Listener = (b: TurnBoundary) => void;

const listeners = new Set<Listener>();

/** Subscribe. Returns the unsubscribe, which only tests bother to call. */
export function onTurnBoundary(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Announce a boundary. O(1) no-op with nobody listening, and every listener is
 * wrapped: this runs inside the SDK message loop, and a throw here would kill
 * the turn it is only supposed to be reporting on.
 */
export function notifyTurnBoundary(b: TurnBoundary): void {
  if (listeners.size === 0) return;
  for (const fn of [...listeners]) {
    try {
      fn(b);
    } catch (e) {
      console.error('[turn-boundary] listener threw:', e);
    }
  }
}

/** Tests only — drop every subscriber. */
export function resetTurnBoundaryListeners(): void {
  listeners.clear();
}
