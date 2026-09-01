import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStaleRun,
  decideRetry,
  retryConfigProblem,
  STALE_MS,
  NOTIFY_MAX_AGE_MS,
} from './cron-recovery';

const T0 = Date.parse('2026-09-01T08:09:43.188Z'); // finance-agent's real fire
const MIN = 60_000;

test('a run inside the gateway cap is not abandoned — the gateway still owns it', () => {
  assert.equal(classifyStaleRun({ firedAtMs: T0, now: T0 + 119 * MIN, supersededBy: 0 }).stale, false);
  assert.equal(classifyStaleRun({ firedAtMs: T0, now: T0 + STALE_MS - 1, supersededBy: 0 }).stale, false);
});

test('the 2026-09-01 finance-agent run: abandoned, and loud', () => {
  // killed 20min in by a gateway restart, still 'running' 9h16m later
  const c = classifyStaleRun({ firedAtMs: T0, now: T0 + (9 * 60 + 16) * MIN, supersededBy: 0 });
  assert.deepEqual(c, { stale: true, quiet: false });
});

test('an orphan a later run has already superseded is closed quietly', () => {
  // otherwise this corpse's `error` overwrites the newer run's lastStatus and
  // turns a currently-healthy cron red.
  const c = classifyStaleRun({ firedAtMs: T0, now: T0 + 3 * 60 * MIN, supersededBy: 1 });
  assert.deepEqual(c, { stale: true, quiet: true });
});

test('ancient orphans are closed quietly — no push about a three-week-old run', () => {
  const c = classifyStaleRun({ firedAtMs: T0, now: T0 + NOTIFY_MAX_AGE_MS + MIN, supersededBy: 0 });
  assert.equal(c.quiet, true);
});

const CFG = { retryEverySec: 1800, retryWindowSec: 3 * 3600, retryUntil: null, retryCount: 0 };

test('only `error` is retried', () => {
  const base = { ...CFG, firedAt: new Date(T0), now: T0 + MIN };
  assert.equal(decideRetry({ ...base, status: 'error' }).kind, 'retry');
  // un-observable is not failed: the work may well have completed
  assert.equal(decideRetry({ ...base, status: 'timeout' }).kind, 'none');
  assert.equal(decideRetry({ ...base, status: 'no_output' }).kind, 'none');
  assert.equal(decideRetry({ ...base, status: 'ok' }).kind, 'none');
});

test('no window configured leaves the row behaving exactly as before', () => {
  const d = decideRetry({
    status: 'error', retryEverySec: null, retryWindowSec: null,
    retryUntil: null, retryCount: 0, firedAt: new Date(T0), now: T0 + MIN,
  });
  assert.equal(d.kind, 'none');
});

test('the first failure stamps a deadline measured from the fire, not from now', () => {
  const d = decideRetry({ ...CFG, status: 'error', firedAt: new Date(T0), now: T0 + 20 * MIN });
  assert.equal(d.kind, 'retry');
  if (d.kind !== 'retry') return;
  assert.equal(d.at.getTime(), T0 + 50 * MIN); // now + 30min
  assert.equal(d.until.getTime(), T0 + 180 * MIN); // fire + 3h
  assert.equal(d.attempt, 1);
});

test('a catch-up that also fails reuses the original deadline, it does not slide it', () => {
  const until = new Date(T0 + 180 * MIN);
  const d = decideRetry({
    ...CFG, status: 'error', retryUntil: until, retryCount: 1,
    firedAt: new Date(T0 + 50 * MIN), now: T0 + 60 * MIN,
  });
  assert.equal(d.kind, 'retry');
  if (d.kind !== 'retry') return;
  assert.equal(d.until.getTime(), until.getTime()); // unchanged
  assert.equal(d.attempt, 2);
});

test('past the window it gives up rather than dropping a daily report at midnight', () => {
  const d = decideRetry({
    ...CFG, status: 'error', retryUntil: new Date(T0 + 180 * MIN), retryCount: 4,
    firedAt: new Date(T0), now: T0 + 175 * MIN, // +30min would land past the deadline
  });
  assert.equal(d.kind, 'giveUp');
});

test('a fire we cannot anchor is never guessed at', () => {
  const d = decideRetry({ ...CFG, status: 'error', firedAt: null, now: T0 });
  assert.equal(d.kind, 'none');
});

test('a window that can never fire is refused at configuration time, not silently', () => {
  const daily = 86_400;
  assert.equal(retryConfigProblem({ retryEverySec: null, retryWindowSec: null, intervalSec: daily }), null);
  assert.equal(retryConfigProblem({ retryEverySec: 1800, retryWindowSec: 10_800, intervalSec: daily }), null);
  // window shorter than one interval: reads fine, never produces an attempt
  assert.match(String(retryConfigProblem({ retryEverySec: 1800, retryWindowSec: 900, intervalSec: daily })), /窗口短于/);
  assert.match(String(retryConfigProblem({ retryEverySec: 60, retryWindowSec: 3600, intervalSec: daily })), /5 分钟/);
  assert.match(String(retryConfigProblem({ retryEverySec: 1800, retryWindowSec: null, intervalSec: daily })), /一起设置/);
  // window >= the task's own period is an unbounded retry loop wearing a window
  assert.match(String(retryConfigProblem({ retryEverySec: 1800, retryWindowSec: daily, intervalSec: daily })), /无限重试/);
});
