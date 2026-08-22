// The two-tier cache's routing rule. The property that matters to a reader is
// "a reload does not re-buy what it already has", and it reduces to these cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { routeKey, IDLE, type KeyState } from './translate-route';

const at = (patch: Partial<KeyState>): KeyState => ({ ...IDLE, ...patch });

test('a fresh block goes to disk first, never straight to the network', () => {
  assert.equal(routeKey(IDLE), 'disk');
});

test('once disk has answered, the key goes to the network', () => {
  // A miss stays a miss for this page load, so re-consulting disk would be a
  // read per render for an answer that cannot have changed.
  assert.equal(routeKey(at({ diskAsked: true })), 'net');
});

test('anything already in hand or already moving is left alone', () => {
  assert.equal(routeKey(at({ known: true })), 'skip');
  assert.equal(routeKey(at({ failed: true })), 'skip', 'a refusal is not retried forever');
  assert.equal(routeKey(at({ inflight: true })), 'skip');
  assert.equal(routeKey(at({ queued: true })), 'skip');
});

test('a key waiting on disk must not ALSO be queued for the network', () => {
  // requestTranslations runs on every render; without this the same block would
  // be bought over the network while its disk lookup was still in flight.
  assert.equal(routeKey(at({ diskPending: true })), 'skip');
  assert.equal(routeKey(at({ diskPending: true, diskAsked: true })), 'skip');
});

test('being known beats every other reason to act', () => {
  assert.equal(routeKey(at({ known: true, diskAsked: true, queued: true })), 'skip');
});

test('the full life of one block: disk, then network, then done', () => {
  const seen: string[] = [];
  const s = { ...IDLE };
  seen.push(routeKey(s));            // disk
  s.diskAsked = true; s.diskPending = true;
  seen.push(routeKey(s));            // skip — waiting on disk
  s.diskPending = false;             // disk missed
  seen.push(routeKey(s));            // net
  s.queued = true;
  seen.push(routeKey(s));            // skip — waiting on the network
  s.queued = false; s.known = true;  // answer landed
  seen.push(routeKey(s));            // skip — forever
  assert.deepEqual(seen, ['disk', 'skip', 'net', 'skip', 'skip']);
});

test('a block found on disk never routes to the network at all', () => {
  const s = { ...IDLE };
  assert.equal(routeKey(s), 'disk');
  s.diskAsked = true; s.diskPending = true;
  s.diskPending = false; s.known = true; // disk HIT → straight into memory
  assert.equal(routeKey(s), 'skip', 'this is the reload case — no network, no cost');
});
