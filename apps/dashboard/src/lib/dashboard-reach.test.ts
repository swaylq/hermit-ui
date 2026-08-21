import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  carriesSessionRows,
  dashboardReach,
  noteDashboardAnswer,
  resetDashboardReach,
  watchDashboardReach,
  CONTACT_GAP_MS,
} from './dashboard-reach';

beforeEach(() => resetDashboardReach());

const T = 1_700_000_000_000;

// ── which answers count ─────────────────────────────────────────────────────
//
// "Did we hear back" has to mean "about THIS data". A query on a slower beat, or
// one that happens to be disabled, must not vouch for rows nobody refreshed —
// that correction would be worse than the bug, because it would keep a row
// looking live while its own poll is dead.

test('the queries that carry session rows are the ones that count', () => {
  // The real tRPC v11 shape: [[...path], {input, type}] (getQueryKeyInternal).
  assert.equal(carriesSessionRows([['chat', 'listSessions'], { input: {}, type: 'query' }]), true);
  assert.equal(carriesSessionRows([['chat', 'getSession'], { input: { sessionId: 'x' }, type: 'query' }]), true);
  assert.equal(carriesSessionRows([['chat', 'listMessages'], { input: {}, type: 'query' }]), false);
  assert.equal(carriesSessionRows([['agents', 'list'], { type: 'query' }]), false);
});

test('a flat key or a junk key is read without throwing', () => {
  // The key shape belongs to tRPC, not to us. If it ever changes, the matcher
  // going quiet must degrade to "no evidence" — observedAt stays 0, every dot
  // holds its last known state — never to a crash or to a grey fleet.
  assert.equal(carriesSessionRows(['chat', 'listSessions']), true);
  assert.equal(carriesSessionRows([]), false);
  assert.equal(carriesSessionRows(null), false);
  assert.equal(carriesSessionRows('chat.listSessions'), false);
  assert.equal(carriesSessionRows([[null, 7], undefined]), false);
});

// ── the run of contact ──────────────────────────────────────────────────────

test('nothing heard yet reads as no evidence, not as freshness', () => {
  assert.deepEqual(dashboardReach(), { observedAt: 0, reachableSince: 0 });
});

test('a steady beat of answers is one unbroken run', () => {
  // The common case, and the one that must NOT keep resetting: while contact
  // holds, the staleness clock has to be allowed to run, or a gateway that
  // really died would never be called out.
  noteDashboardAnswer(T);
  const started = dashboardReach().reachableSince;
  for (let i = 1; i <= 20; i++) noteDashboardAnswer(T + i * 5_000);
  assert.equal(dashboardReach().reachableSince, started, 'a healthy 5s beat never trips the gap');
  assert.equal(dashboardReach().observedAt, T + 100_000);
});

test('the first answer of all starts a run — nothing before it was observed', () => {
  noteDashboardAnswer(T);
  assert.deepEqual(dashboardReach(), { observedAt: T, reachableSince: T });
});

test('a gap in answers starts a new run', () => {
  // We went blind for a minute. Whatever the gateway failed to write in that
  // minute is explained by the outage we shared with it, not by the gateway.
  noteDashboardAnswer(T);
  noteDashboardAnswer(T + 5_000);
  noteDashboardAnswer(T + 65_000);
  assert.deepEqual(dashboardReach(), { observedAt: T + 65_000, reachableSince: T + 65_000 });
});

test('a gap just inside the tolerance is still the same run', () => {
  noteDashboardAnswer(T);
  noteDashboardAnswer(T + CONTACT_GAP_MS);
  assert.equal(dashboardReach().reachableSince, T, 'one slow poll is not an outage');
  noteDashboardAnswer(T + CONTACT_GAP_MS + CONTACT_GAP_MS + 1);
  assert.equal(dashboardReach().reachableSince, T + 2 * CONTACT_GAP_MS + 1);
});

test('answers never walk the stamps backwards', () => {
  // React Query can settle a slow request after a fast one, so events do arrive
  // out of order. A stamp that moved back would re-age rows that are current —
  // and worse, an old timestamp would look like a gap and hand out free grace.
  noteDashboardAnswer(T);
  noteDashboardAnswer(T + 5_000);
  noteDashboardAnswer(T - 60_000);
  assert.deepEqual(dashboardReach(), { observedAt: T + 5_000, reachableSince: T });
});

// ── the QueryCache wiring ───────────────────────────────────────────────────

function fakeCache() {
  let listener: ((e: unknown) => void) | null = null;
  return {
    subscribe(fn: (e: unknown) => void) {
      listener = fn;
      return () => { listener = null; };
    },
    emit(e: unknown) { listener?.(e); },
    get subscribed() { return listener !== null; },
  };
}

const updated = (proc: string, action: string) => ({
  type: 'updated',
  query: { queryKey: [['chat', proc], { type: 'query' }] },
  action: { type: action },
});

test('a resolved carrier query is an answer', () => {
  const cache = fakeCache();
  watchDashboardReach(cache);
  const before = Date.now();
  cache.emit(updated('listSessions', 'success'));
  assert.ok(dashboardReach().observedAt >= before);
  cache.emit(updated('getSession', 'success'));
  assert.ok(dashboardReach().observedAt >= before);
});

test('data we wrote ourselves is not an answer', () => {
  // setQueryData dispatches the SAME 'success' action a fetch does, flagged
  // manual. This app calls it on every mark-read — i.e. constantly, while a turn
  // is running — so counting those would make the record freshest exactly when
  // the polls it stands in for are stalled.
  const cache = fakeCache();
  watchDashboardReach(cache);
  cache.emit({
    type: 'updated',
    query: { queryKey: [['chat', 'listSessions'], { type: 'query' }] },
    action: { type: 'success', manual: true },
  });
  assert.deepEqual(dashboardReach(), { observedAt: 0, reachableSince: 0 });
});

test('everything that is not an answer is ignored', () => {
  // Failures included, and on purpose: a single query that fails forever (a
  // stale session id, a rejected key) would otherwise pin the record and switch
  // `stale` off for the whole fleet, silently. A gap in ANSWERS cannot be faked
  // that way — it exists only if the answers really stopped.
  const cache = fakeCache();
  watchDashboardReach(cache);
  cache.emit(updated('listSessions', 'error'));
  cache.emit(updated('listSessions', 'failed'));
  cache.emit(updated('listSessions', 'fetch'));   // a request STARTING is not an answer
  cache.emit(updated('listMessages', 'success')); // right server, wrong data
  cache.emit({ type: 'added', query: { queryKey: [['chat', 'listSessions']] } });
  cache.emit({ type: 'updated' });                // malformed — must not throw
  cache.emit(undefined);
  assert.deepEqual(dashboardReach(), { observedAt: 0, reachableSince: 0 });
});

test('watching hands back an unsubscribe', () => {
  const cache = fakeCache();
  const off = watchDashboardReach(cache);
  assert.equal(cache.subscribed, true);
  off();
  assert.equal(cache.subscribed, false);
});
