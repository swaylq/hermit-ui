import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPm2Self } from './machine-requests';

// The gateway asks `bash -lc "pm2 jlist"` who it is. Everything that can go
// wrong here is silent — a wrong answer restarts the wrong app, or updates a
// checkout this gateway does not run from.

const entry = (over: Record<string, unknown> = {}) => ({
  name: 'hermit-ui-gateway',
  pid: 4242,
  pm2_env: { pm_cwd: '/Users/mac/claudeclaw/asst/hermit-ui/apps/gateway' },
  ...over,
});

test('finds this process by pid and strips /apps/gateway off the repo path', () => {
  const out = JSON.stringify([entry({ name: 'other', pid: 7 }), entry()]);
  assert.deepEqual(pickPm2Self(out, 4242), {
    app: 'hermit-ui-gateway',
    repo: '/Users/mac/claudeclaw/asst/hermit-ui',
  });
});

test('a login shell banner ahead of the JSON does not break parsing', () => {
  const out = `Welcome to this machine\n[PM2] you have mail\n${JSON.stringify([entry()])}`;
  assert.equal(pickPm2Self(out, 4242)?.repo, '/Users/mac/claudeclaw/asst/hermit-ui');
});

test('no entry for our pid means no answer — never fall back to a name', () => {
  // A second gateway on the box would otherwise be restarted in our place.
  assert.equal(pickPm2Self(JSON.stringify([entry({ pid: 99 })]), 4242), null);
});

test('unparseable, empty and non-array output all answer null', () => {
  assert.equal(pickPm2Self('pm2: command not found', 4242), null);
  assert.equal(pickPm2Self('', 4242), null);
  assert.equal(pickPm2Self('[not json', 4242), null);
  assert.equal(pickPm2Self('{"pid":4242}', 4242), null);
});

test('a cwd that is not the gateway dir is kept as-is', () => {
  const out = JSON.stringify([entry({ pm2_env: { pm_cwd: '/opt/hermit-ui' } })]);
  assert.equal(pickPm2Self(out, 4242)?.repo, '/opt/hermit-ui');
});

test('an entry with no name is not us', () => {
  const out = JSON.stringify([entry({ name: undefined })]);
  assert.equal(pickPm2Self(out, 4242), null);
});
