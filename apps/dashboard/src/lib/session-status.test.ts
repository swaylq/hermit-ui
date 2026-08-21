import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatusView, activityLabel } from './session-status';

// ── the label a working session shows ───────────────────────────────────────
//
// "working" is everything a scraped terminal spinner can support. A backend with
// a typed event stream can say WHICH tool and for how long, or that the session
// is not slow but rate-limited — which is the difference between a chat that
// looks hung and one that explains itself.

test('a backend that cannot say keeps the label it always had', () => {
  assert.equal(sessionStatusView({ alive: true, state: 'working' }).label, 'working');
  assert.equal(sessionStatusView({ alive: true, state: 'working', activity: null }).label, 'working');
});

test('a running tool is named with its elapsed time', () => {
  const v = sessionStatusView({
    alive: true, state: 'working',
    activity: { kind: 'tool', label: 'Bash', detail: 'npm test', elapsedSec: 47 },
  });
  assert.equal(v.key, 'working', 'still the working state — only the wording changed');
  assert.equal(v.label, 'Bash · 47s');
  assert.equal(v.detail, 'npm test');
});

test('minutes read as minutes', () => {
  assert.equal(activityLabel({ kind: 'tool', label: 'Bash', elapsedSec: 200 })?.label, 'Bash · 3m 20s');
  assert.equal(activityLabel({ kind: 'tool', label: 'Bash', elapsedSec: 180 })?.label, 'Bash · 3m');
  assert.equal(activityLabel({ kind: 'tool', label: 'Bash', elapsedSec: 0 })?.label, 'Bash');
});

// The state the pane could not report at all: a rate-limited session just looked
// hung, and the user had no way to tell waiting from wedged.
test('a rate limit says so, with the count and the wait', () => {
  const v = sessionStatusView({
    alive: true, state: 'working',
    activity: { kind: 'retrying', label: 'retrying', attempt: 2, maxRetries: 5, retryInSec: 12 },
  });
  assert.equal(v.label, 'retrying 2/5, 12s');
});

test('subagent, compaction and background each get their own wording', () => {
  assert.equal(
    activityLabel({ kind: 'subagent', label: 'code-reviewer', detail: 'review the diff' })?.label,
    'code-reviewer',
  );
  assert.equal(activityLabel({ kind: 'compacting', label: 'compacting' })?.label, 'compacting');
  assert.equal(activityLabel({ kind: 'background', label: 'background', backgroundCount: 2 })?.label, 'background +2 bg');
});

test('background work is counted alongside the foreground', () => {
  assert.equal(
    activityLabel({ kind: 'tool', label: 'Read', elapsedSec: 3, backgroundCount: 2 })?.label,
    'Read · 3s +2 bg',
  );
  // Zero is not worth saying.
  assert.equal(activityLabel({ kind: 'tool', label: 'Read', backgroundCount: 0 })?.label, 'Read');
});

// It arrives through an opaque JSON column, so nothing in it is guaranteed —
// including its shape after a gateway upgrade this build predates.
test('an unreadable payload falls back rather than throwing', () => {
  for (const junk of [null, undefined, 'working', 42, [], {}, { kind: 'something-new' }]) {
    assert.equal(activityLabel(junk), null, JSON.stringify(junk));
    assert.equal(
      sessionStatusView({ alive: true, state: 'working', activity: junk }).label,
      'working',
    );
  }
});

// Activity only ever REFINES the working state. A stale payload on an idle
// session must not resurrect it — `state` is the authority on whether a turn is
// in flight.
test('activity never contradicts the state', () => {
  const idle = sessionStatusView(
    { alive: true, state: 'idle', activity: { kind: 'tool', label: 'Bash', elapsedSec: 900 } },
    { unread: false },
  );
  assert.equal(idle.key, 'ready');
  assert.equal(idle.label, 'ready');
});

test('a client-side working signal picks up the label too', () => {
  const v = sessionStatusView(
    { alive: true, state: 'idle', activity: { kind: 'compacting', label: 'compacting' } },
    { liveWorking: true },
  );
  assert.equal(v.label, 'compacting');
});
