// seedPiConfigFromEnv promotes the legacy .env knobs into the machine's
// credential catalog, so Settings → Models shows what the machine actually
// runs. The rules that matter are all about NOT clobbering something a human
// set, so that is what this pins down.
//
// planCredentialSeed is the real decision the seeder makes; the I/O around it
// (read the catalog, write it back) is not what can go wrong here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCredentialSeed as plan, type PiConfig, type ModelCredential } from './pi-config';

const ENV: PiConfig = {
  provider: 'hyqubit',
  baseUrl: 'https://litellm.hyqubit.com',
  api: 'anthropic-messages',
  models: ['claude-opus-5', 'claude-sonnet-5'],
  secretKey: 'LITELLM_HYQUBIT_TOKEN',
};

test('an empty catalog is seeded from the env', () => {
  const out = plan(ENV, []);
  assert.ok(out);
  assert.equal(out.credential.id, 'hyqubit');
  assert.equal(out.credential.provider, 'hyqubit');
  assert.equal(out.credential.baseUrl, 'https://litellm.hyqubit.com');
  assert.deepEqual(out.credential.models, ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(out.credential.secretKey, 'LITELLM_HYQUBIT_TOKEN');
  assert.equal(out.credential.defaultModel, 'claude-opus-5');
});

// A credential on its own is not something you can start a chat on, so the seed
// has to create the pi backend built on it too — otherwise a machine that had
// been running pi entirely from .env comes up with no pi backend at all.
test('the seed creates the pi backend, not just the credential', () => {
  const out = plan(ENV, [])!;
  assert.deepEqual(out.instance, {
    id: 'pi-hyqubit', harness: 'pi-rpc', credentialId: 'hyqubit', label: 'pi · hyqubit',
  });
});

test('a catalog that already has anything is never touched', () => {
  // Someone configured the page. Overwriting it from a stale .env would be a
  // settings change nobody asked for, on every gateway restart.
  const existing: ModelCredential[] = [{
    id: 'openrouter', label: 'OpenRouter', provider: 'openrouter', api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1', models: [],
  }];
  assert.equal(plan(ENV, existing), null);
});

test('an env with no endpoint has nothing to promote', () => {
  assert.equal(plan({}, []), null);
  assert.equal(plan({ provider: 'hyqubit' }, []), null); // no baseUrl
});

test('a provider name that is not a slug still yields a usable id', () => {
  const out = plan({ ...ENV, provider: 'My Relay (EU)' }, [])!;
  assert.equal(out.credential.id, 'my-relay-eu');
  assert.equal(out.instance.credentialId, 'my-relay-eu');
});
