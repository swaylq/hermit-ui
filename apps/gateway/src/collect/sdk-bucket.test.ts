import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBucketsIn, noteProbeGap, STALE_AFTER_MS, STALE_REPEAT_MS } from './sdk-bucket';

// The shape this account reports TODAY, copied from a live probe on 2026-08-21.
// The interactive windows are populated; the programmatic one is null, which is
// what says the SDK is still drawing on the subscription.
const TODAY = {
  five_hour: { utilization: 4, resets_at: '2026-08-20T20:10:00Z', limit_dollars: null },
  seven_day: { utilization: 6, resets_at: '2026-08-27T01:00:00Z', limit_dollars: null },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
};

test('the current subscription shape raises nothing', () => {
  assert.deepEqual(splitBucketsIn(TODAY), []);
});

test('no reading at all raises nothing', () => {
  assert.deepEqual(splitBucketsIn(null), []);
  assert.deepEqual(splitBucketsIn({}), []);
});

// The thing this exists to catch: the paused 2026-06-15 split coming back.
test('a populated programmatic window is reported', () => {
  const split = { ...TODAY, seven_day_oauth_apps: { utilization: 12, limit_dollars: 200, resets_at: 'x' } };
  assert.deepEqual(splitBucketsIn(split), ['seven_day_oauth_apps']);
});

test('every window name the split could arrive under is watched', () => {
  assert.deepEqual(
    splitBucketsIn({ five_hour_oauth_apps: { utilization: 0 } }),
    ['five_hour_oauth_apps'],
  );
  assert.deepEqual(splitBucketsIn({ oauth_apps: { resets_at: 'x' } }), ['oauth_apps']);
});

// Zero utilisation still means the bucket EXISTS and is being metered — that is
// the transition worth alerting on, not the moment it fills up.
test('a split at zero utilisation is still a split', () => {
  assert.deepEqual(
    splitBucketsIn({ ...TODAY, seven_day_oauth_apps: { utilization: 0, resets_at: 'x' } }),
    ['seven_day_oauth_apps'],
  );
});

// A key that appears but carries no numbers is not evidence of anything, and
// alerting on it would cry wolf on a payload shape change.
test('an empty placeholder window is not an alert', () => {
  assert.deepEqual(splitBucketsIn({ seven_day_oauth_apps: {} }), []);
  assert.deepEqual(splitBucketsIn({ seven_day_oauth_apps: false as any }), []);
});

// ── The sentinel that could not run ─────────────────────────────────────────
// The probe asks the LIVE sessions and returns null when there are none, and
// the tick used to answer that with a bare return. On a machine with nothing
// open, "no alert" and "never checked" were the same output — for the one guard
// against a failure whose first symptom is a bill. These are about the second
// state being visible.

const H = 3_600_000;
const T0 = 1_700_000_000_000;

test('a reading stamps the clock and says nothing', () => {
  const r = noteProbeGap({ lastOkAt: T0 - 99 * H, lastStaleWarnAt: T0 - H }, true, T0);
  assert.equal(r.warning, null);
  assert.equal(r.next.lastOkAt, T0);
  // The warn stamp is dropped with it, so the NEXT outage is reported on its own
  // schedule rather than being muted by the last one.
  assert.equal(r.next.lastStaleWarnAt, undefined);
});

test('a machine that has never checked starts the clock, it does not cry immediately', () => {
  const r = noteProbeGap({}, false, T0);
  assert.equal(r.warning, null);
  assert.equal(r.next.lastOkAt, T0);
});

test('a gap shorter than the threshold is just a quiet machine', () => {
  const r = noteProbeGap({ lastOkAt: T0 - (STALE_AFTER_MS - 1) }, false, T0);
  assert.equal(r.warning, null);
  assert.equal(r.next.lastOkAt, T0 - (STALE_AFTER_MS - 1), 'a failed probe must not stamp a reading');
});

test('a gap past the threshold is reported, with how long it has been', () => {
  const r = noteProbeGap({ lastOkAt: T0 - 9 * H }, false, T0);
  assert.match(String(r.warning), /has not been able to read the plan windows for 9h/);
  assert.match(String(r.warning), /NOT\s+running on this machine/);
  assert.equal(r.next.lastStaleWarnAt, T0);
});

test('it does not repeat itself hourly for as long as the machine stays quiet', () => {
  const st = { lastOkAt: T0 - 9 * H, lastStaleWarnAt: T0 };
  for (let i = 1; i <= 12; i++) {
    assert.equal(noteProbeGap(st, false, T0 + i * H).warning, null, `hour ${i}`);
  }
});

test('but a long outage restates itself, so it cannot be forgotten', () => {
  const st = { lastOkAt: T0 - 9 * H, lastStaleWarnAt: T0 };
  const r = noteProbeGap(st, false, T0 + STALE_REPEAT_MS);
  assert.match(String(r.warning), /for 33h/);
  assert.equal(r.next.lastStaleWarnAt, T0 + STALE_REPEAT_MS);
});
