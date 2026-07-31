// When does this window reset, in Shanghai, and how long have I got — the two
// questions the usage page's clocks exist to answer.
//
// Two different sources feed it:
//   · the plan windows, whose reset is a STRING scraped out of the `claude /usage`
//     TUI ("5:20am (Asia/Shanghai)", "Aug 2 at 1am (Asia/Shanghai)") — no instant,
//     no ISO, just what the panel drew;
//   · the ccusage cost windows, which do carry a real endTime.
//
// The string ones have to be parsed into an instant before anything can count down
// to them, and that parse has to go through the named zone: the text says which
// zone it's in, and it is NOT necessarily the viewer's (a gateway on the VPS reports
// UTC). Everything is then rendered in Shanghai, which is where the person reading
// this page lives — a fixed zone also means the same number on the laptop and the
// phone, wherever either happens to be.
//
// Pure and side-effect free (the only input beyond the text is `now`), so the parse
// rules are unit-testable without a clock or a browser.

export const DISPLAY_TZ = 'Asia/Shanghai';
export const DISPLAY_TZ_LABEL = 'Shanghai';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * How far the zone's wall clock is ahead of UTC at a given instant. Read back out of
 * Intl rather than hardcoded, so DST (and any future rule change) comes for free.
 */
function zoneOffsetMs(instant: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p: Record<string, number> = {};
  for (const { type, value } of dtf.formatToParts(new Date(instant))) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }
  // hour12:false still renders midnight as 24 in some ICU builds.
  const hour = p.hour === 24 ? 0 : p.hour;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return asUtc - instant;
}

/**
 * A wall-clock reading in some zone → the instant it names. Two passes: the offset
 * depends on the instant we're solving for, so guess with the first offset and
 * re-read it at the guess (enough for every real zone, DST edges included).
 */
export function zonedToInstant(
  w: { year: number; month: number; day: number; hour: number; minute: number },
  tz: string,
): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const guess = naive - zoneOffsetMs(naive, tz);
  return naive - zoneOffsetMs(guess, tz);
}

/** The y/m/d a zone is currently on. */
function zoneToday(instant: number, tz: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p: Record<string, number> = {};
  for (const { type, value } of dtf.formatToParts(new Date(instant))) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * Parse a `claude /usage` reset string into the instant it points at. Returns null on
 * anything unrecognised — the caller then shows the raw text, so an unfamiliar format
 * degrades to what the page displayed before rather than to nothing.
 *
 * Handles what the panel actually prints:
 *   "5:20am (Asia/Shanghai)"        → the next 05:20 in that zone
 *   "Aug 2 at 1am (Asia/Shanghai)"  → Aug 2, 01:00 in that zone, year inferred
 *   "11pm"                          → no zone named: read in `fallbackTz`
 */
export function parseResetText(text: string | null | undefined, now: Date, fallbackTz = DISPLAY_TZ): Date | null {
  if (!text) return null;
  const s = text.trim();

  const tzMatch = s.match(/\(([A-Za-z_]+\/[A-Za-z_+-]+|UTC)\)/);
  const tz = tzMatch ? tzMatch[1] : fallbackTz;

  const time = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!time) return null;
  let hour = parseInt(time[1], 10);
  const minute = time[2] ? parseInt(time[2], 10) : 0;
  const pm = time[3].toLowerCase() === 'pm';
  if (hour === 12) hour = 0;          // 12am → 00, 12pm → 12 (below)
  if (pm) hour += 12;
  if (hour > 23 || minute > 59) return null;

  const date = s.match(/\b([A-Za-z]{3})[a-z]*\s+(\d{1,2})\b/);
  const today = zoneToday(now.getTime(), tz);

  if (date) {
    const month = MONTHS.indexOf(date[1].toLowerCase()) + 1;
    if (month === 0) return null;
    const day = parseInt(date[2], 10);
    // The panel prints no year. Take this year, and roll forward if that lands well
    // in the past — the only real case is a reset in early January read in December.
    let year = today.year;
    let at = zonedToInstant({ year, month, day, hour, minute }, tz);
    if (at < now.getTime() - 2 * 86400_000) {
      year += 1;
      at = zonedToInstant({ year, month, day, hour, minute }, tz);
    }
    return new Date(at);
  }

  // Time only: the next time that clock reading comes round. A session window is
  // always under 24h, so "already passed today" means tomorrow.
  let at = zonedToInstant({ ...today, hour, minute }, tz);
  if (at <= now.getTime()) at = zonedToInstant({ ...today, hour, minute, day: today.day + 1 }, tz);
  return new Date(at);
}

/** "6h 31m" / "12m" / "3d 4h". Empty string once the target is behind us. */
export function untilText(target: Date | string | number, now: Date): string {
  const ms = new Date(target).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return m ? `${hours}h ${m}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
}

/**
 * A clock reading in Shanghai. `withDate` adds "Aug 2, " — worth it for a weekly
 * window, noise for one that resets within the day.
 */
export function formatShanghai(d: Date | string | number, opts: { withDate?: boolean } = {}): string {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TZ,
    ...(opts.withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** True when the two instants fall on different Shanghai days — i.e. show the date. */
export function crossesDay(a: Date | string | number, b: Date | string | number): boolean {
  const day = (x: Date | string | number) =>
    new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(x));
  return day(a) !== day(b);
}
