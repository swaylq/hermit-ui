import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDshCommand } from './dsh-exec';

// The usage arithmetic (totalTokens / lastCallUsage) is covered beside the
// translator in dsh-events.test.ts; the spawn path itself is exercised against
// a real dsh install by scripts/dsh-e2e.mts, not here.

test('HERMIT_DSH_BIN pointing at a js file runs it with node', () => {
  const cmd = resolveDshCommand({ HERMIT_DSH_BIN: '/opt/dsh/lib/bin.js' } as NodeJS.ProcessEnv);
  assert.equal(cmd?.cmd, process.execPath);
  assert.deepEqual(cmd?.args, ['/opt/dsh/lib/bin.js']);
});

test('HERMIT_DSH_BIN naming a binary runs it as itself', () => {
  // A machine with dsh on PATH sets HERMIT_DSH_BIN=dsh.
  assert.deepEqual(resolveDshCommand({ HERMIT_DSH_BIN: 'dsh' } as NodeJS.ProcessEnv), { cmd: 'dsh', args: [] });
  assert.deepEqual(
    resolveDshCommand({ HERMIT_DSH_BIN: '/usr/local/bin/dsh' } as NodeJS.ProcessEnv),
    { cmd: '/usr/local/bin/dsh', args: [] },
  );
});

test('a blank override falls through to the default install lookup', () => {
  // The default depends on this machine's ~/.dsh, so only the shape is pinned:
  // either dsh is installed there (node + its bin.js) or it is absent (null,
  // which submit reports into the chat instead of failing silently).
  const cmd = resolveDshCommand({ HERMIT_DSH_BIN: '  ' } as NodeJS.ProcessEnv);
  if (cmd !== null) {
    assert.equal(cmd.cmd, process.execPath);
    assert.match(cmd.args[0] ?? '', /@deepseek-ai\/dsh\/lib\/bin\.js$/);
  }
});
