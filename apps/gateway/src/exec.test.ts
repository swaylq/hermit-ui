import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execCapture } from './exec';

test('a timeout settles even when a grandchild still holds the pipes', async () => {
  // The shape that hangs: bash is the child, `sleep` is the grandchild, and the
  // grandchild inherits stdout — so SIGKILLing bash does not close the pipe and
  // 'close' never fires. Anything awaiting this promise would wait forever.
  const started = Date.now();
  const res = await execCapture('bash', ['-lc', 'sleep 5 & echo started; wait'], { timeoutMs: 400 });
  assert.equal(res.timedOut, true);
  assert.ok(res.stdout.includes('started'), 'keeps whatever the child managed to write');
  assert.ok(Date.now() - started < 5_000, `settled in ${Date.now() - started}ms`);
});

test('a command that finishes in time reports its own status and output', async () => {
  const res = await execCapture('bash', ['-lc', 'echo hi; exit 3'], { timeoutMs: 10_000 });
  assert.equal(res.timedOut, false);
  assert.equal(res.status, 3);
  assert.equal(res.stdout.trim(), 'hi');
});
