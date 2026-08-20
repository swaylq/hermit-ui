import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBucketsIn } from './sdk-bucket';

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
