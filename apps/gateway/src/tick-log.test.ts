import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TickLog, SLOW_TICK_MS, ROLLUP_MS, ERROR_REPEAT_MS } from './tick-log';

// A log is behaviour, and behaviour that only shows up as "the file got big"
// rots without anyone noticing. Measured before this existed: 160,973 lines and
// 17.5MB in one day, 26,501 of them a single tick saying it took 40ms.

const T0 = 1_700_000_000_000;

test('a routine success says nothing at all — the 26,501 lines', () => {
  const log = new TickLog(T0);
  for (let i = 0; i < 100; i++) {
    assert.equal(log.ok('chat-cancel-tick', 40, T0 + i * 1_500), null);
  }
});

test('a slow tick still speaks', () => {
  const log = new TickLog(T0);
  assert.equal(log.ok('snapshots', SLOW_TICK_MS - 1, T0), null);
  assert.match(String(log.ok('snapshots', SLOW_TICK_MS, T0)), /\[snapshots\] slow: 2000ms/);
});

test('the first failure is printed in full', () => {
  const log = new TickLog(T0);
  assert.equal(log.error('chat', '502', T0), '[chat] error: 502');
});

test('the same failure repeating is counted, not reprinted', () => {
  const log = new TickLog(T0);
  log.error('chat', '502', T0);
  // Every 2s for just under the restate window: a hundred failures, no lines.
  for (let i = 1; i <= 140; i++) assert.equal(log.error('chat', '502', T0 + i * 2_000), null, `i=${i}`);
});

test('a DIFFERENT failure is never swallowed — it is the one that matters', () => {
  const log = new TickLog(T0);
  log.error('chat', '502', T0);
  log.error('chat', '502', T0 + 2_000);
  assert.equal(log.error('chat', 'ECONNREFUSED', T0 + 4_000), '[chat] error: ECONNREFUSED (+1 identical in the last 4s)');
});

test('an outage that outlives the window re-states itself, with the count', () => {
  const log = new TickLog(T0);
  log.error('chat', '502', T0);
  for (let i = 1; i < 5; i++) log.error('chat', '502', T0 + i * 60_000);
  const line = log.error('chat', '502', T0 + ERROR_REPEAT_MS);
  assert.match(String(line), /^\[chat\] error: 502 \(\+4 identical in the last 5m00s\)$/);
});

// Recovery has to be IN the log. Inferring it from the absence of further
// errors is exactly the reasoning that misses a poller that stopped running.
test('coming back is a line of its own', () => {
  const log = new TickLog(T0);
  log.error('chat', '502', T0);
  log.error('chat', '502', T0 + 30_000);
  assert.equal(log.ok('chat', 90, T0 + 60_000), '[chat] back after 2 failures (1m00s) — ok in 90ms');
  // ...and then it goes quiet again.
  assert.equal(log.ok('chat', 90, T0 + 62_000), null);
});

test('one failure reads as one failure', () => {
  const log = new TickLog(T0);
  log.error('cron', 'boom', T0);
  assert.match(String(log.ok('cron', 10, T0 + 1_000)), /back after 1 failure \(/);
});

test('the rollup is not due before its window', () => {
  const log = new TickLog(T0);
  log.ok('chat', 10, T0);
  assert.equal(log.rollup(T0 + ROLLUP_MS - 1), null);
});

test('the rollup reports the busiest first, with the slowest each hid', () => {
  const log = new TickLog(T0);
  for (let i = 0; i < 200; i++) log.ok('chat-cancel', 40, T0 + i);
  for (let i = 0; i < 37; i++) log.ok('snapshots', i === 9 ? 1_400 : 600, T0 + i);
  const line = log.rollup(T0 + ROLLUP_MS);
  assert.equal(line, '[ticks] 5m00s · chat-cancel 200× (max 40ms) · snapshots 37× (max 1400ms)');
});

// The degradation a silent success would otherwise hide: nothing crossed the
// slow threshold, but the max moved from 600ms to 1400ms and the rollup says so.
test('counters reset between windows, so each line is about its own window', () => {
  const log = new TickLog(T0);
  for (let i = 0; i < 5; i++) log.ok('chat', 600, T0 + i);
  log.rollup(T0 + ROLLUP_MS);
  log.ok('chat', 100, T0 + ROLLUP_MS + 1);
  assert.equal(log.rollup(T0 + 2 * ROLLUP_MS), '[ticks] 5m00s · chat 1× (max 100ms)');
});

test('a window in which nothing ran says so — quiet and stopped are different', () => {
  const log = new TickLog(T0);
  assert.equal(log.rollup(T0 + ROLLUP_MS), '[ticks] 5m00s · nothing ran');
});

test('a label still failing is named in the rollup, not just in the error line', () => {
  const log = new TickLog(T0);
  log.error('chat', '502', T0);
  log.error('chat', '502', T0 + 2_000);
  log.ok('cron', 10, T0 + 3_000);
  assert.equal(log.rollup(T0 + ROLLUP_MS), '[ticks] 5m00s · chat 0× (max 0ms), 2 failing in a row · cron 1× (max 10ms)');
});

// A long outage re-states itself every ERROR_REPEAT_MS. If the recovery line
// measured from the last RESTATEMENT it would report a 20-minute outage as a
// five-minute one — so it measures from when the failures began.
test('the recovery line reports the whole outage, not the last restatement', () => {
  const log = new TickLog(T0);
  log.error('chat', '502', T0);
  log.error('chat', '502', T0 + ERROR_REPEAT_MS);        // restated
  log.error('chat', '502', T0 + 2 * ERROR_REPEAT_MS);    // restated again
  assert.match(String(log.ok('chat', 50, T0 + 20 * 60_000)), /back after 3 failures \(20m00s\)/);
});
