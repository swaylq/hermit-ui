// Letting the transcript ARRIVE instead of appear.
//
// Streaming ASR delivers in lumps: nothing for 400 ms, then four characters at
// once. Written straight through, the draft twitches. Fed through here it reads
// as typing — which is also honest, because the words really are arriving one
// after another, just faster than a person types.
//
// Three motions, and telling them apart is the whole job:
//
//   APPEND — the normal case. Reveal `step` more characters per tick.
//
//   SHORT REWIND — the ASR correcting its own tail ("发 red hot" → "把Red Hole").
//     The wrong tail is dropped in ONE frame and then retyped. Backspacing it a
//     character at a time was the first attempt and it looked broken rather than
//     deliberate — the half-deleted states are nonsense words ("…PADDY重重") that
//     read as a rendering bug. Vanish-then-retype still shows it changing its
//     mind, which is the effect worth keeping.
//
//   LONG REWIND — the per-sentence polish landing on a sentence you finished
//     talking about, with a whole second sentence typed after it. Backspacing
//     through all of that to fix one word upstream would be a lot of churn for a
//     small correction, so it SNAPS. The fix appears at once, where it belongs.

/** How long a tick is. ~36 chars/s at step 1 — well ahead of ASR's ~10. */
export const TYPE_TICK_MS = 28;
/** Deleting further back than this isn't the ASR changing its mind; it's an edit upstream. */
export const MAX_REWIND = 12;
/** Backlog per step, so a big append (a reconnect, a paste) still lands quickly. */
const BACKLOG_PER_STEP = 12;

export function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Characters to move this tick: 1 normally, more when badly behind. */
export function stepFor(displayed: string, target: string): number {
  const backlog = Math.abs(target.length - displayed.length);
  return Math.max(1, Math.ceil(backlog / BACKLOG_PER_STEP));
}

/** One tick of the animation: `displayed` moved toward `target`. */
export function typeFrame(displayed: string, target: string, step = stepFor(displayed, target)): string {
  if (displayed === target) return displayed;
  const p = commonPrefixLen(displayed, target);
  const rewind = displayed.length - p;
  if (rewind > MAX_REWIND) return target;   // an edit upstream — snap, don't crawl
  if (rewind > 0) return displayed.slice(0, p); // drop the wrong tail at once
  return target.slice(0, Math.min(target.length, displayed.length + step)); // type forward
}
