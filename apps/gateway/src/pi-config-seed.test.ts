// seedPiConfigFromEnv promotes the legacy .env knobs into the dashboard config
// so Settings → Pi Runtime shows what the machine actually runs. The rules that
// matter are all about NOT clobbering something a human set, so that is what
// this pins down.
//
// planPiConfigSeed is the real decision the seeder makes; the I/O around it
// (read config, write config) is not what can go wrong here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPiConfigSeed as plan } from './pi-config';

const ENV = {
  provider: 'hyqubit',
  baseUrl: 'https://litellm.hyqubit.com',
  api: 'anthropic-messages',
  models: ['claude-opus-5', 'claude-sonnet-5'],
  secretKey: 'LITELLM_HYQUBIT_TOKEN',
};

test('an empty stored config is seeded from the env', () => {
  const out = plan(ENV, null) as any;
  assert.equal(out.provider, 'hyqubit');
  assert.equal(out.baseUrl, 'https://litellm.hyqubit.com');
  assert.deepEqual(out.models, ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(out.secretKey, 'LITELLM_HYQUBIT_TOKEN');
  assert.equal(out.defaultModel, 'claude-opus-5');
});

test('a config that already names a provider is never touched', () => {
  // Someone configured the page. Overwriting it from a stale .env would be a
  // settings change nobody asked for, on every gateway restart.
  assert.equal(plan(ENV, { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }), null);
});

test('an env with no endpoint has nothing to promote', () => {
  assert.equal(plan({}, null), null);
  assert.equal(plan({ provider: 'hyqubit' }, null), null); // no baseUrl
});

test('settings the env knows nothing about survive the seed', () => {
  // The vision block and the auth mode live only in the DB; a seed that dropped
  // them would silently turn image recognition off.
  const remote = {
    image: { enabled: true, provider: 'openrouter', apiKeySecret: 'OPENROUTER_API_KEY' },
    authMode: 'cc-subscription',
  };
  const out = plan(ENV, remote) as any;
  assert.deepEqual(out.image, remote.image);
  assert.equal(out.authMode, 'cc-subscription');
});

test('an existing defaultModel wins over the head of the env list', () => {
  const out = plan(ENV, { defaultModel: 'claude-sonnet-5' }) as any;
  assert.equal(out.defaultModel, 'claude-sonnet-5');
});

test('an existing secretKey wins over the env one', () => {
  const out = plan(ENV, { secretKey: 'SOME_OTHER_TOKEN' }) as any;
  assert.equal(out.secretKey, 'SOME_OTHER_TOKEN');
});
