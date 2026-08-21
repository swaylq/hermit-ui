import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { publishSessionStatus, clearSessionStatus, parseLiveStatus } from './session-live';

// A DOM the module can talk to: localStorage as a Map, and a window that counts
// the wake-up events instead of dispatching them. Safe to install after the
// import — the module guards on `typeof window` at CALL time and reads
// `localStorage` off the global, so nothing touches either until a test runs.
const store = new Map<string, string>();
let events = 0;
Object.assign(globalThis, {
  window: { dispatchEvent: () => { events += 1; return true; } },
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
});

beforeEach(() => { store.clear(); events = 0; });

// ── what the sidebar reads back ─────────────────────────────────────────────
//
// A report is only worth obeying while the chat page that wrote it is still
// there to correct it. Everything below is a way for that to stop being true.

test('a fresh report is taken at face value', () => {
  assert.equal(parseLiveStatus(`working|${1_000_000}`, 1_000_000), 'working');
  assert.equal(parseLiveStatus(`needs-you|${1_000_000}`, 1_002_000), 'needs-you');
  assert.equal(parseLiveStatus(`idle|${1_000_000}`, 1_000_500), 'idle');
});

// The tab was closed, or crashed: no unmount, so no cleanup ran. Without the TTL
// the last thing it said pins that session's dot for good.
test('a report nobody is refreshing any more expires', () => {
  assert.equal(parseLiveStatus(`working|${1_000_000}`, 1_000_000 + 19_999), 'working');
  assert.equal(parseLiveStatus(`working|${1_000_000}`, 1_000_000 + 20_001), null);
});

// localStorage outlives a deploy, so this build will meet entries written by
// another one. Unreadable means "no opinion", never a guess.
test('an entry this build cannot read is no opinion at all', () => {
  for (const junk of [null, '', 'working', '|', 'working|', 'working|nope', '|123', 'busy|1000000']) {
    assert.equal(parseLiveStatus(junk, 1_000_000), null, JSON.stringify(junk));
  }
});

// ── what the chat page writes ───────────────────────────────────────────────

test('publishing round-trips through the store', () => {
  publishSessionStatus('s1', 'working');
  assert.equal(parseLiveStatus(store.get('hermit:status:s1') ?? null, Date.now()), 'working');
});

// The open chat page re-stamps on a timer so its report cannot age past the TTL
// mid-turn. That refresh must be free for readers: the sidebar re-renders on the
// wake-up event, and a session list is not something to re-render every 5s for
// news that isn't news.
test('re-stamping an unchanged status wakes nobody', () => {
  publishSessionStatus('s1', 'working');
  assert.equal(events, 1, 'the first report is news');
  publishSessionStatus('s1', 'working');
  publishSessionStatus('s1', 'working');
  assert.equal(events, 1, 'saying it again is not');
  publishSessionStatus('s1', 'idle');
  assert.equal(events, 2, 'changing your mind is');
});

// Leaving a session has to be said out loud — a sidebar holding a stale
// 'working' will not re-read the store until something tells it to.
test('falling silent wakes the readers, but only if we were speaking', () => {
  clearSessionStatus('s1');
  assert.equal(events, 0, 'nothing to retract');
  publishSessionStatus('s1', 'working');
  clearSessionStatus('s1');
  assert.equal(events, 2);
  assert.equal(store.get('hermit:status:s1'), undefined);
  assert.equal(parseLiveStatus(null, Date.now()), null);
});

test('sessions do not read each other’s reports', () => {
  publishSessionStatus('s1', 'working');
  publishSessionStatus('s2', 'needs-you');
  assert.equal(parseLiveStatus(store.get('hermit:status:s1') ?? null, Date.now()), 'working');
  assert.equal(parseLiveStatus(store.get('hermit:status:s2') ?? null, Date.now()), 'needs-you');
  clearSessionStatus('s1');
  assert.equal(parseLiveStatus(store.get('hermit:status:s2') ?? null, Date.now()), 'needs-you');
});
