// How a growing reply gets onto the screen.
//
// The gateway does not hand the browser a stream of characters. It upserts one
// placeholder row every 250ms (LIVE_PUSH_MS in runtime/claude-sdk.ts), the SSE
// handler coalesces those into pushes 100ms apart, and React Query hands the
// component a row that jumped forward by however much the model wrote in the
// meantime. Painted straight through, a reply arrives as three or four chunks a
// second — which is what "streaming" looked like on the dashboard until now, and
// what it should never look like again.
//
// So the arrival rate and the reading rate are deliberately decoupled: pushes
// fill a buffer, and the reveal drains it at its own steady pace. That is the
// same trick a video player uses on a jittery network, and it needs the same
// three parts.
//
//   PACE — `revealAdvance`. Speed is proportional to the backlog, so the reveal
//     lags REVEAL_LAG_MS behind the text and, at a steady arrival rate, runs at
//     exactly that rate. The lag is the whole point: drain the buffer completely
//     and you are back to stalling between pushes, which reads as chunks again.
//
//   SPLIT — `settleSplit`. Markdown of the whole revealed prefix, re-parsed
//     every frame, costs 2–4ms per frame on a 2k reply (measured with the app's
//     own react-markdown + remark-gfm + rehype-highlight pipeline) and grows
//     with the message. So the text is cut at the last completed block: the part
//     above is memoized and re-parses only when a block closes, and only the
//     block being typed is re-parsed per frame — 0.5–1ms for prose of any
//     length, 2.6ms for a 1.5k open code fence.
//
//   CARRY — `adoptReveal`. The placeholder row is retracted and replaced by the
//     real one the moment a content block finishes. That is a different row id,
//     so the component remounts, and without a memory of how far the reveal had
//     got, the paragraph the user just watched arrive would vanish and retype
//     itself from zero.

/** How far behind the arriving text the reveal deliberately runs. */
export const REVEAL_LAG_MS = 550;

/**
 * The lag once the text has gone quiet — nothing left to buffer against, so the
 * reveal stops holding back and closes the reply. Without this the last ~60
 * characters of a finished reply take 1.2s to land, which reads as the page
 * being slow rather than as someone still typing.
 */
export const FINISH_LAG_MS = 180;

/**
 * How long the text must stand still before that applies. Pushes land 250ms
 * apart plus up to 100ms of SSE coalescing, so a gap this long is the stream
 * ending, not the stream being late.
 */
export const QUIET_MS = 500;

/**
 * Floor speed in characters/second. Backlog-proportional pacing approaches the
 * end asymptotically and would leave the last few characters crawling; this is
 * what actually closes a finished reply, in about the time a fast typist would.
 */
export const MIN_CPS = 34;

/** Reveal cadence. 30fps is smooth for text and halves the tail's parse bill. */
export const TICK_MS = 33;

/**
 * A frame longer than this is a stall (a background tab, a long task), not a
 * frame. Clamped so the reveal resumes rather than teleports — the backlog is
 * still consumed within a few frames, because the pace scales with it.
 */
export const MAX_FRAME_MS = 100;

/**
 * Longest tail handed to the markdown renderer. Past it the tail is painted as
 * plain text: the only block that can get this big without an internal newline
 * to settle at is a long fenced code block, and that is the one construct whose
 * re-parse cost (highlight.js) does climb with length.
 */
export const TAIL_MD_MAX = 1500;

/** A remembered position is only worth adopting for as long as a row swap takes. */
export const ADOPT_MAX_AGE_MS = 5_000;

/** Below this, a matching prefix is coincidence rather than continuity. */
const ADOPT_MIN_CHARS = 8;

/**
 * One frame of the reveal: `shown` (fractional — a 30fps tick can be worth less
 * than a character) moved toward `total`.
 *
 * `quietMs` is how long it has been since the text last grew, and it is what
 * tells a buffer being refilled apart from one that is all there is.
 */
export function revealAdvance(shown: number, total: number, dtMs: number, quietMs = 0): number {
  if (shown >= total) return total;
  const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS) / 1000;
  const backlog = total - shown;
  const lag = (quietMs > QUIET_MS ? FINISH_LAG_MS : REVEAL_LAG_MS) / 1000;
  const cps = Math.max(MIN_CPS, backlog / lag);
  return Math.min(total, shown + cps * dt);
}

/** Offset of the line opening an unclosed ``` / ~~~ fence, or -1 if none is open. */
export function openFenceAt(text: string): number {
  let open = -1;
  let i = 0;
  for (;;) {
    const nl = text.indexOf('\n', i);
    const line = text.slice(i, nl === -1 ? text.length : nl);
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) open = open === -1 ? i : -1;
    if (nl === -1) return open;
    i = nl + 1;
  }
}

/**
 * Cut the revealed text into the part that is finished with (settled) and the
 * block still being typed (tail).
 *
 * The cut is the last blank line, because that is where markdown ends a block
 * and therefore the last point at which the two halves render exactly as the
 * whole would. Two exceptions:
 *
 *   · Nothing after an open code fence can settle — cutting a fence in half
 *     renders as two stacked code boxes.
 *   · A block that grows past `maxTail` (a long list, a wide table) settles by
 *     whole LINES instead, so its re-parse cost stops growing. The seam costs a
 *     few pixels of extra leading between the settled list and its last item,
 *     which closes as soon as that line settles too.
 */
export function settleSplit(revealed: string, maxTail = TAIL_MD_MAX): { settled: string; tail: string } {
  const fence = openFenceAt(revealed);
  const limit = fence === -1 ? revealed.length : fence;
  let cut = 0;
  const blank = limit >= 2 ? revealed.lastIndexOf('\n\n', limit - 2) : -1;
  if (blank !== -1) cut = blank + 2;
  if (revealed.length - cut > maxTail && limit >= 1) {
    const nl = revealed.lastIndexOf('\n', limit - 1);
    if (nl + 1 > cut) cut = nl + 1;
  }
  return { settled: revealed.slice(0, cut), tail: revealed.slice(cut) };
}

/**
 * Close a fence the reveal has only opened, so a code block being typed renders
 * as a code block rather than as the rest of the message in a monospace box.
 */
export function closeOpenFence(tail: string): string {
  const at = openFenceAt(tail);
  if (at === -1) return tail;
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(tail.slice(at))?.[1] ?? '```';
  return `${tail}${tail.endsWith('\n') ? '' : '\n'}${marker}`;
}

// ── Carrying the position across a row swap ──────────────────────────────────

type Mark = { text: string; shown: number; at: number };

/** Keyed by chat session: at most one row in it is ever the live tail. */
const marks = new Map<string, Mark>();

/** Bounded so a long-lived tab that visits many sessions cannot accumulate. */
const MAX_MARKS = 16;

export function markReveal(key: string, text: string, shown: number, now = Date.now()): void {
  if (!key) return;
  if (!marks.has(key) && marks.size >= MAX_MARKS) {
    for (const [k, m] of marks) if (now - m.at > ADOPT_MAX_AGE_MS) marks.delete(k);
    if (marks.size >= MAX_MARKS) marks.delete(marks.keys().next().value as string);
  }
  marks.set(key, { text, shown, at: now });
}

/**
 * Where a freshly mounted row should start revealing from: the position the row
 * it replaces had reached, if this text really is a continuation of it.
 *
 * `startsWith` on the revealed prefix is the test, so a genuinely new block —
 * the second paragraph of a reply, a new turn — still types from the beginning.
 */
export function adoptReveal(key: string, text: string, now = Date.now()): number {
  const m = key ? marks.get(key) : undefined;
  if (!m || now - m.at > ADOPT_MAX_AGE_MS) return 0;
  const shown = Math.min(m.shown, m.text.length, text.length);
  if (shown < ADOPT_MIN_CHARS) return 0;
  return text.startsWith(m.text.slice(0, shown)) ? shown : 0;
}

/** Test seam. */
export function resetReveals(): void {
  marks.clear();
}
