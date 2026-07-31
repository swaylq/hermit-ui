// The usage page's two clocks. The parse target is the literal text `claude /usage`
// draws — captured from the live panel: "5:20am (Asia/Shanghai)" for the session
// window, "Aug 2 at 1am (Asia/Shanghai)" for the weekly one. Everything is pinned to
// explicit instants so the suite doesn't care what zone it runs in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetText, untilText, formatShanghai, zonedToInstant, crossesDay } from './reset-time';

// 2026-07-31T18:49Z = 2026-08-01 02:49 in Shanghai.
const NOW = new Date('2026-07-31T18:49:00.000Z');

describe('zonedToInstant', () => {
  it('reads a Shanghai wall clock as UTC+8', () => {
    assert.equal(
      new Date(zonedToInstant({ year: 2026, month: 8, day: 2, hour: 1, minute: 0 }, 'Asia/Shanghai')).toISOString(),
      '2026-08-01T17:00:00.000Z',
    );
  });
  it('follows a zone that actually has DST', () => {
    // New York is UTC-4 in July, UTC-5 in January.
    assert.equal(
      new Date(zonedToInstant({ year: 2026, month: 7, day: 1, hour: 12, minute: 0 }, 'America/New_York')).toISOString(),
      '2026-07-01T16:00:00.000Z',
    );
    assert.equal(
      new Date(zonedToInstant({ year: 2026, month: 1, day: 1, hour: 12, minute: 0 }, 'America/New_York')).toISOString(),
      '2026-01-01T17:00:00.000Z',
    );
  });
});

describe('parseResetText', () => {
  it('reads the session form — the next occurrence of that clock time', () => {
    // 05:20 Shanghai is still ahead of 02:49 Shanghai → later today.
    const at = parseResetText('5:20am (Asia/Shanghai)', NOW)!;
    assert.equal(at.toISOString(), '2026-07-31T21:20:00.000Z');
    assert.equal(untilText(at, NOW), '2h 31m');
  });

  it('rolls a time that has already passed today into tomorrow', () => {
    // 01:00 Shanghai is behind 02:49 Shanghai → tomorrow.
    const at = parseResetText('1am (Asia/Shanghai)', NOW)!;
    assert.equal(at.toISOString(), '2026-08-01T17:00:00.000Z');
  });

  it('reads the weekly form, inferring the year', () => {
    const at = parseResetText('Aug 2 at 1am (Asia/Shanghai)', NOW)!;
    assert.equal(at.toISOString(), '2026-08-01T17:00:00.000Z');
    assert.equal(untilText(at, NOW), '22h 11m');
  });

  it('honours a zone that is NOT the display zone', () => {
    // 1am UTC on Aug 2 is 09:00 Shanghai — the point of parsing in the NAMED zone.
    const at = parseResetText('Aug 2 at 1am (UTC)', NOW)!;
    assert.equal(at.toISOString(), '2026-08-02T01:00:00.000Z');
    assert.equal(formatShanghai(at, { withDate: true }), 'Aug 2, 09:00');
  });

  it('falls back to the display zone when no zone is named', () => {
    assert.equal(parseResetText('11pm', NOW)!.toISOString(), '2026-08-01T15:00:00.000Z');
  });

  it('handles the 12am / 12pm corners', () => {
    assert.equal(parseResetText('12am (Asia/Shanghai)', NOW)!.toISOString(), '2026-08-01T16:00:00.000Z');
    assert.equal(parseResetText('12pm (Asia/Shanghai)', NOW)!.toISOString(), '2026-08-01T04:00:00.000Z');
  });

  it('rolls a December reading of a January reset into next year', () => {
    const dec = new Date('2026-12-30T12:00:00.000Z');
    assert.equal(parseResetText('Jan 2 at 1am (Asia/Shanghai)', dec)!.toISOString(), '2027-01-01T17:00:00.000Z');
  });

  it('returns null on anything it does not recognise, so the caller can show the raw text', () => {
    assert.equal(parseResetText(null, NOW), null);
    assert.equal(parseResetText('', NOW), null);
    assert.equal(parseResetText('soon', NOW), null);
    assert.equal(parseResetText('25:00am', NOW), null);
    assert.equal(parseResetText('Foo 2 at 1am', NOW), null);
  });
});

describe('untilText', () => {
  const t = (ms: number) => untilText(new Date(NOW.getTime() + ms), NOW);
  it('counts minutes, hours then days', () => {
    assert.equal(t(30_000), '1m'); // under a minute still reads as time left, not gone
    assert.equal(t(12 * 60_000), '12m');
    assert.equal(t(60 * 60_000), '1h');
    assert.equal(t(91 * 60_000), '1h 31m');
    assert.equal(t(26 * 3600_000), '1d 2h');
    assert.equal(t(48 * 3600_000), '2d');
  });
  it('is empty once the moment has passed', () => {
    assert.equal(t(0), '');
    assert.equal(t(-60_000), '');
  });
});

describe('formatShanghai / crossesDay', () => {
  it('renders 24h Shanghai time, with an optional date', () => {
    const d = new Date('2026-07-31T17:00:00.000Z'); // 01:00 Aug 1 in Shanghai
    assert.equal(formatShanghai(d), '01:00');
    assert.equal(formatShanghai(d, { withDate: true }), 'Aug 1, 01:00');
  });
  it('spots a window whose ends fall on different Shanghai days', () => {
    assert.equal(crossesDay('2026-07-31T17:00:00.000Z', '2026-07-31T22:00:00.000Z'), false); // both Aug 1
    assert.equal(crossesDay('2026-07-31T10:00:00.000Z', '2026-07-31T17:00:00.000Z'), true);  // Jul 31 → Aug 1
  });
  it('survives a bad date rather than throwing in render', () => {
    assert.equal(formatShanghai('not a date'), '—');
  });
});
