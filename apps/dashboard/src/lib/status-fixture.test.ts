// Keeps `apps/ios/tools/fixtures/status-cases.json` honest.
//
// That file is the ONLY thing tying the Swift port of `sessionStatusView`
// (apps/ios/Hermit/SessionStatus.swift) to this one. `apps/ios/tools/status-fixture.sh`
// runs the Swift implementation against every case in it; this test asserts the
// table is still what this module produces. Change the ladder on this side and
// the table goes stale, so this goes red — on a machine with no Xcode, which is
// where the change will be made.
//
//     pnpm --filter @hermit-ui/dashboard gen:status-fixture
import assert from 'node:assert/strict';
import test from 'node:test';

import { FIXTURE_JSON, buildFixture, checkedInFixture, renderFixture } from '../../scripts/gen-status-fixture';
import { BACKGROUND_RESIDENT_MS, SNAPSHOT_STALE_MS } from './session-status';

test('the checked-in status fixture is what sessionStatusView produces today', () => {
  assert.equal(
    checkedInFixture(),
    renderFixture(),
    `${FIXTURE_JSON} is stale. Run: pnpm --filter @hermit-ui/dashboard gen:status-fixture`,
  );
});

test('the table was built with the thresholds this module actually exports', () => {
  // The Swift side reads these two out of the GENERATED contract and asserts
  // they equal the numbers recorded here. Without this, a rename could leave
  // the table carrying a hard-coded 45000 that agrees with nothing.
  const f = buildFixture();
  assert.equal(f.snapshotStaleMs, SNAPSHOT_STALE_MS);
  assert.equal(f.backgroundResidentMs, BACKGROUND_RESIDENT_MS);
});

test('the table still covers what a port gets wrong', () => {
  const f = buildFixture();
  const status = new Map(f.statuses.map((c) => [c.name, c]));
  const activity = new Map(f.activities.map((c) => [c.name, c]));
  const duration = new Map(f.durations.map((c) => [c.sec, c.expected]));

  // The ORDER of the ladder, which is the whole design and is not stated
  // anywhere as a list. Each of these is a pair that a reader could easily
  // resolve the other way.
  assert.equal(status.get('needs-you-outranks-all')?.expected.key, 'needs-you');
  assert.equal(status.get('live-working-outranks-closed')?.expected.key, 'working');
  assert.equal(status.get('closed')?.expected.key, 'down');
  assert.equal(status.get('stale')?.expected.key, 'stale');
  assert.equal(status.get('restarting-beats-unread')?.expected.key, 'restarting');
  assert.equal(status.get('starting-beats-unread')?.expected.key, 'starting');
  assert.equal(status.get('unread-beats-asleep')?.expected.key, 'unread');
  assert.equal(status.get('asleep')?.expected.key, 'asleep');

  // The staleness check is a strict `>`, so 45s exactly is still believable.
  assert.equal(status.get('stale-boundary-just-under')?.expected.key, 'ready');
  assert.equal(status.get('stale-boundary-just-over')?.expected.key, 'stale');

  // A parked background task is `working` with a DIMMED, unpulsed dot. The
  // opacity is the only thing separating it from a turn in flight.
  const parked = status.get('parked-background-blob');
  assert.equal(parked?.expected.dot, 'bg-amber-400/50');
  assert.equal(parked?.expected.pulse, false);
  // …and it expires. Half an hour after the agent's last word the task is a
  // resident process, not part of an answer.
  assert.equal(status.get('background-gone-resident')?.expected.key, 'ready', 'still parked?');
  assert.equal(status.get('background-just-inside-resident')?.expected.key, 'working');

  // `observedAt: 0` means we have never heard from the dashboard, which is not
  // the same as having heard from it at the epoch.
  assert.equal(status.get('never-observed')?.silenceMs, null);
  assert.equal(status.get('never-observed')?.expected.key, 'ready');

  // JavaScript's falsy-empty-string, twice, and its number formatting.
  assert.equal(activity.get('tool-empty-label')?.label?.label, 'tool · 3s');
  assert.equal(activity.get('retrying-zeros')?.label?.label, 'retrying');
  assert.equal(activity.get('tool-fractional')?.label?.label, 'Bash · 12.5s');
  assert.equal(duration.get(90.5), '1m 30.5s');
  assert.equal(duration.get(3600), '1h');

  // An opaque JSON column that is not an object reads as "cannot say".
  for (const name of ['array', 'string']) {
    assert.equal(activity.get(name)?.label, null, `${name} should not produce a label`);
    assert.equal(activity.get(name)?.summary, null);
  }
});
