// tick-log.ts — what a periodic tick is allowed to say.
//
// The gateway runs ~20 loops, the fastest every 1.5 seconds, and each one used
// to write a line on SUCCESS. Measured on this machine: 160,973 lines and
// 17.5 MB of out.log in one day, about four lines a second, of which the top
// entry alone (`[chat-cancel-tick] ok in 40ms`, 26,501 times) carried no
// information any human or grep would ever want.
//
// That is not a tidiness problem. A log nobody can read is a log nobody reads,
// and the two things it exists to answer — "is it still ticking?" and "what
// went wrong at 03:12?" — were both buried under the answer "yes, 40ms" printed
// four times a second.
//
// So a successful tick is silent, and the three cases that are NOT routine each
// keep their line:
//
//   - slow    — a tick over SLOW_TICK_MS, which is the shape of a hung poll or a
//               collector that has grown teeth (the heaviest one here, the
//               session snapshot, runs at ~620ms);
//   - failed  — every distinct failure, once, with a count when it repeats;
//   - back    — the first success after a failure, so recovery is in the log
//               rather than inferred from the absence of more errors.
//
// And every ROLLUP_MS a single line reports what all the quiet ticks did,
// including their slowest, so a degradation from 600ms to 1400ms is visible
// without any tick having crossed the slow threshold.

/** A tick slower than this says so. Well above the heaviest normal collector. */
export const SLOW_TICK_MS = 2_000;

/** How often the quiet ticks are summarised in one line. */
export const ROLLUP_MS = 5 * 60_000;

/**
 * A failure that keeps repeating identically re-states itself this often.
 *
 * The dashboard going away 502s every poller at once — a dozen loops, each
 * failing every 1.5-4s for as long as it lasts. Printing all of them is how a
 * five-minute blip becomes thousands of lines that hide the one error that
 * mattered.
 */
export const ERROR_REPEAT_MS = 5 * 60_000;

type LabelStats = {
  ok: number;
  fail: number;
  maxMs: number;
  /** Did the last attempt fail? Drives the recovery line. */
  failing: boolean;
  lastError: string | null;
  /** When the CURRENT failure was last printed — drives repeat suppression. */
  lastErrorAt: number;
  /**
   * When this run of failures began.
   *
   * Separate from lastErrorAt on purpose: a long outage re-states itself every
   * ERROR_REPEAT_MS, which moves lastErrorAt forward, so measuring the recovery
   * from it would report a 20-minute outage as a 5-minute one.
   */
  failingSince: number;
  /** Identical failures swallowed since lastError was printed. */
  suppressed: number;
};

function blank(): LabelStats {
  return { ok: 0, fail: 0, maxMs: 0, failing: false, lastError: null, lastErrorAt: 0, failingSince: 0, suppressed: 0 };
}

function human(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Decides what a tick prints. Returns the line, or null for "say nothing".
 *
 * A pure decision object with the clock passed in: what gets logged is exactly
 * the kind of behaviour that rots silently, and this way it is asserted rather
 * than eyeballed against a live log.
 */
export class TickLog {
  private labels = new Map<string, LabelStats>();
  private lastRollupAt: number;

  constructor(now: number) {
    this.lastRollupAt = now;
  }

  private at(label: string): LabelStats {
    let s = this.labels.get(label);
    if (!s) { s = blank(); this.labels.set(label, s); }
    return s;
  }

  /** A tick that succeeded. */
  ok(label: string, ms: number, now: number): string | null {
    const s = this.at(label);
    s.ok += 1;
    if (ms > s.maxMs) s.maxMs = ms;
    if (s.failing) {
      const n = s.fail;
      const since = now - s.failingSince;
      s.failing = false;
      s.lastError = null;
      s.suppressed = 0;
      s.fail = 0;
      return `[${label}] back after ${n} failure${n === 1 ? '' : 's'} (${human(since)}) — ok in ${ms}ms`;
    }
    return ms >= SLOW_TICK_MS ? `[${label}] slow: ${ms}ms` : null;
  }

  /** A tick that threw. `message` is already flattened — no stack. */
  error(label: string, message: string, now: number): string | null {
    const s = this.at(label);
    s.fail += 1;
    const isNew = !s.failing || message !== s.lastError;
    const stale = now - s.lastErrorAt >= ERROR_REPEAT_MS;
    if (!isNew && !stale) {
      s.suppressed += 1;
      return null;
    }
    const repeat = s.suppressed > 0
      ? ` (+${s.suppressed} identical in the last ${human(now - s.lastErrorAt)})`
      : '';
    if (!s.failing) s.failingSince = now;
    s.failing = true;
    s.lastError = message;
    s.lastErrorAt = now;
    s.suppressed = 0;
    return `[${label}] error: ${message}${repeat}`;
  }

  /**
   * The periodic one-liner, or null when it is not due yet.
   *
   * Reports every label that did something, busiest first, with its slowest
   * tick — the signal a silent success can otherwise hide. A window in which
   * NOTHING ran still prints, because "the loops stopped" and "the loops are
   * quiet" look identical in a log that only speaks when something happens.
   */
  rollup(now: number): string | null {
    if (now - this.lastRollupAt < ROLLUP_MS) return null;
    const span = human(now - this.lastRollupAt);
    this.lastRollupAt = now;
    const rows = [...this.labels.entries()]
      .filter(([, s]) => s.ok > 0 || s.fail > 0)
      .sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail) || a[0].localeCompare(b[0]));
    if (rows.length === 0) return `[ticks] ${span} · nothing ran`;
    const parts = rows.map(([label, s]) => {
      // `fail` is NOT reset here: it counts consecutive failures and belongs to
      // the outage, not to the window. The recovery line is what clears it.
      const fail = s.fail > 0 ? `, ${s.fail} failing in a row` : '';
      return `${label} ${s.ok}× (max ${s.maxMs}ms)${fail}`;
    });
    for (const [, s] of rows) { s.ok = 0; s.maxMs = 0; }
    return `[ticks] ${span} · ${parts.join(' · ')}`;
  }
}
