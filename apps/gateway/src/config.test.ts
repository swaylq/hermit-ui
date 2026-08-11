import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// assertRequiredConfig is a process-killer, so it is exercised in a child
// process. The env is built from scratch (not spread from process.env) so a
// developer's own ASST_KEY/AGENTS_ROOT cannot make these pass by accident.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.join(SRC, '..', '..', '..', 'node_modules', '.bin', 'tsx');

function runAssert(env: Record<string, string>) {
  return spawnSync(
    TSX,
    ['-e', "import('./src/config.ts').then(m => { m.assertRequiredConfig(); console.log('OK'); })"],
    {
      cwd: path.join(SRC, '..'),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        // dotenv would otherwise load a real apps/gateway/.env and hand the
        // child exactly the values these cases exist to withhold.
        DOTENV_CONFIG_PATH: '/nonexistent/.env',
        ...env,
      },
    },
  );
}

// The whole point of the fail-fast: a wrong-but-present AGENTS_ROOT yields a
// silently empty fleet, which has taken hours to notice. Absent must be loud.
test('a missing AGENTS_ROOT refuses to start, and says how to fix it', () => {
  const r = runAssert({ ASST_KEY: 'k' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing AGENTS_ROOT/);
  assert.match(r.stderr, /apps\/gateway\/\.env/);
});

// Skipped on a Mac whose keychain holds asst-gateway-vps-key: config.ts falls
// back to it by design, so there is no way to present a "missing ASST_KEY" to
// the assertion from here. The keychain read is itself the thing under test on
// such a machine, and it is passing.
const keychainHasKey = process.platform === 'darwin' && spawnSync(
  'security',
  ['find-generic-password', '-a', 'asst', '-s', 'asst-gateway-vps-key', '-w'],
  { encoding: 'utf8', timeout: 1500 },
).status === 0;

test('a missing ASST_KEY refuses to start', { skip: keychainHasKey ? 'keychain supplies ASST_KEY on this machine' : false }, () => {
  const r = runAssert({ AGENTS_ROOT: '/tmp' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing ASST_KEY/);
});

test('both present starts', () => {
  const r = runAssert({ ASST_KEY: 'k', AGENTS_ROOT: '/tmp' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

// The regression that motivated moving the check out of module scope: half the
// suite imports something that transitively imports config, and an
// import-time process.exit(1) took all of those tests down with it.
test('importing config does NOT exit, even with nothing configured', () => {
  const r = spawnSync(
    TSX,
    ['-e', "import('./src/config.ts').then(m => console.log('imported', m.AGENTS_ROOT === '' ? 'empty' : 'set'))"],
    {
      cwd: path.join(SRC, '..'),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DOTENV_CONFIG_PATH: '/nonexistent/.env',
      },
    },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /imported/);
});
