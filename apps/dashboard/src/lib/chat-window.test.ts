import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_WINDOW, TIMELINE_DIGEST, timelineQueryInput, timelineStreamParams } from './chat-window';

// The two transports merge by id into ONE list. Everything here is about them
// describing the same window — a disagreement is silent at compile time and
// shows up as a capsule changing height under the reader, or as a hover
// prefetch that warms a cache entry the page never reads.

test('the query input and the stream params describe the same window', () => {
  const q = timelineQueryInput('s1');
  const p = new URLSearchParams(timelineStreamParams('s1', { skipInitial: true }));
  assert.equal(p.get('sessionId'), q.sessionId);
  assert.equal(Number(p.get('limit')), q.limit);
  assert.equal(p.get('digest') === '1', q.digest, 'fidelity must agree across transports');
});

test('the window is the fixed size, not a growing one', () => {
  assert.equal(timelineQueryInput('s1').limit, INITIAL_WINDOW);
  assert.equal(INITIAL_WINDOW, 60);
});

test('the query input is a plain value, so two callers produce the same key', () => {
  // The sidebar's prefetch and the chat page's useQuery build this
  // independently; react-query hashes it, so it has to be deep-equal.
  assert.deepEqual(timelineQueryInput('s1'), timelineQueryInput('s1'));
  assert.notDeepEqual(timelineQueryInput('s1'), timelineQueryInput('s2'));
});

test('skipInitial is sent only when asked, and delta always', () => {
  const first = new URLSearchParams(timelineStreamParams('s1', { skipInitial: true }));
  assert.equal(first.get('skipInitial'), '1');
  assert.equal(first.get('delta'), '1');
  // A RECONNECT must not skip: it emits the current window once to catch up on
  // whatever landed during the gap.
  const again = new URLSearchParams(timelineStreamParams('s1', { skipInitial: false }));
  assert.equal(again.get('skipInitial'), null);
  assert.equal(again.get('delta'), '1');
});

test('the session id is escaped rather than interpolated', () => {
  const p = new URLSearchParams(timelineStreamParams('a&b=c d', { skipInitial: false }));
  assert.equal(p.get('sessionId'), 'a&b=c d');
});

test('the digest kill switch reaches both transports together', () => {
  // Flipping TIMELINE_DIGEST is the documented way back to full fidelity; it
  // must not be possible to flip it for one transport only.
  const q = timelineQueryInput('s1');
  const p = new URLSearchParams(timelineStreamParams('s1', { skipInitial: false }));
  assert.equal(q.digest, TIMELINE_DIGEST);
  assert.equal(p.get('digest') === '1', TIMELINE_DIGEST);
});
