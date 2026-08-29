// collect/session-state-push.ts — turn boundaries, on the wire immediately.
//
// The 8s `pushSessionSnapshots` tick stays exactly as it was and remains the
// source of truth for everything expensive (context tokens, transcript path,
// prompt snippets, pane RSS). This is the cheap half, and it carries the ONE
// fact that cannot wait: whether a turn is running.
//
// Three deliberate limits, because this fires from inside the SDK message loop:
//
//  1. It never probes. The runtime hands the verdict over with the notification
//     (`runtime/turn-boundary.ts`), so nothing here reads a transcript, shells
//     out, or touches the filesystem. A boundary costs one small POST.
//  2. It coalesces. A turn start can produce two notifications a millisecond
//     apart (submit, then the CLI's `running` frame); a burst across sessions
//     lands in one batch. One in-flight POST at a time, and anything that
//     arrives while it is in flight is merged and sent right after.
//  3. It sends PARTIAL items. Only `state`/`alive`/`activity` are known here, and
//     the sync route's full shape would write null over the eight columns the
//     8s tick owns. `partial: true` is what stops that.

import { api } from '../api';
import { onTurnBoundary, type TurnBoundary } from '../runtime/turn-boundary';

/**
 * How long boundaries are gathered before a POST goes out.
 *
 * Short enough to be invisible next to the 8s tick it pre-empts, long enough
 * that `submit()` and the CLI's own `running` frame — measured at under a
 * millisecond apart — cost one request rather than two.
 */
const COALESCE_MS = 120;

/** Last state written per session, so an unchanged boundary sends nothing. */
const lastSent = new Map<string, string>();
/** Bounded: a fleet machine holds ~100 live sessions and each entry is tiny. */
const LAST_SENT_CAP = 500;

const queued = new Map<string, TurnBoundary>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/** Where a batch goes. Swapped in tests; nothing else has a reason to touch it. */
type Poster = (items: unknown[]) => Promise<unknown>;
let post: Poster = (items) => api.syncSessionSnapshots(items as any[]);

/** The signature that decides whether a boundary is worth a request. */
function sigOf(b: TurnBoundary): string {
  const a = b.activity as { kind?: unknown; label?: unknown } | null | undefined;
  // Elapsed seconds are deliberately NOT in the signature: they change every
  // second of a long tool call, and re-POSTing for a ticking clock would turn a
  // two-requests-per-turn feature into a per-second one. The 8s tick refreshes
  // the elapsed readout, which is what it is for.
  return `${b.working ? 1 : 0}|${a?.kind ?? ''}|${a?.label ?? ''}`;
}

/**
 * Take everything queued and send it. Failures are swallowed on purpose: the 8s
 * snapshot re-states all of it a moment later, so a dropped acceleration is a
 * slower dashboard, never a wrong one — and a throw here would land in the SDK
 * message loop.
 */
async function flush(): Promise<void> {
  timer = null;
  if (inFlight || queued.size === 0) return;
  const batch = [...queued.values()];
  queued.clear();
  const items = batch.map((b) => ({
    sessionId: b.sessionId,
    // Only ever sent for a session with a live handle — that is what having a
    // turn boundary to report means.
    alive: true,
    state: b.working ? 'working' : 'idle',
    activity: b.activity ?? null,
    partial: true,
  }));
  inFlight = true;
  try {
    await post(items);
    for (const b of batch) lastSent.set(b.sessionId, sigOf(b));
  } catch {
    // Re-send next time: drop the memo so an identical boundary is not skipped
    // as "already sent" when it never landed.
    for (const b of batch) lastSent.delete(b.sessionId);
  } finally {
    inFlight = false;
    // Anything that arrived mid-flight goes out now rather than waiting for the
    // next boundary — a turn that started and ended inside one POST would
    // otherwise leave the dashboard showing `working` until the 8s tick.
    if (queued.size > 0 && timer == null) timer = setTimeout(() => { void flush(); }, COALESCE_MS);
  }
  if (lastSent.size > LAST_SENT_CAP) {
    for (const k of [...lastSent.keys()].slice(0, lastSent.size - LAST_SENT_CAP)) lastSent.delete(k);
  }
}

/**
 * Wire the runtime's boundaries to the dashboard. Call once, at startup.
 *
 * `poster` exists so a test can watch what goes out without a dashboard; the
 * default is the real sync call.
 */
export function startSessionStatePush(poster?: Poster): () => void {
  if (poster) post = poster;
  return onTurnBoundary((b) => {
    if (lastSent.get(b.sessionId) === sigOf(b) && !queued.has(b.sessionId)) return;
    queued.set(b.sessionId, b);
    if (timer == null) timer = setTimeout(() => { void flush(); }, COALESCE_MS);
  });
}

/** Tests only. */
export function _resetSessionStatePush(): void {
  if (timer != null) clearTimeout(timer);
  timer = null;
  inFlight = false;
  queued.clear();
  lastSent.clear();
  post = (items) => api.syncSessionSnapshots(items as any[]);
}

/** Tests only — how long a caller must wait for a queued batch to go out. */
export const _COALESCE_MS = COALESCE_MS;
