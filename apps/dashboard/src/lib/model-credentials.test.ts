import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialFrom, formFromPreset, modelCredentialsOf, defaultModelOf,
  uniqueCredentialId, EMPTY_CREDENTIAL_FORM, CREDENTIAL_PRESETS,
} from './model-credentials';

const FORM = {
  ...EMPTY_CREDENTIAL_FORM,
  provider: 'hyqubit',
  baseUrl: 'https://litellm.hyqubit.com',
  models: 'claude-opus-5, claude-sonnet-5',
  secretKey: 'LITELLM_HYQUBIT_TOKEN',
};

// ── what the add dialog stores ──────────────────────────────────────────────

test('a blank name falls back to the provider id', () => {
  assert.equal(credentialFrom(FORM, []).label, 'hyqubit');
  assert.equal(credentialFrom({ ...FORM, label: '  My Relay ' }, []).label, 'My Relay');
});

// Backends reference a credential by id. Two sharing one would point a backend
// at the wrong endpoint, silently.
test('the id is derived from the label and made unique', () => {
  assert.equal(credentialFrom(FORM, []).id, 'hyqubit');
  assert.equal(credentialFrom(FORM, ['hyqubit']).id, 'hyqubit-2');
  assert.equal(credentialFrom({ ...FORM, label: 'My Relay (EU)' }, []).id, 'my-relay-eu');
});

test('the model list is split, trimmed, and stripped of the empties', () => {
  assert.deepEqual(credentialFrom(FORM, []).models, ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(credentialFrom({ ...FORM, models: ' a , , b, ' }, []).models, ['a', 'b']);
  assert.deepEqual(credentialFrom({ ...FORM, models: '' }, []).models, []);
});

// defaultModelOf falls through to models[0] only when defaultModel is ABSENT,
// so storing '' would pin the credential to nothing at all.
test('a blank default model is omitted, not stored empty', () => {
  const c = credentialFrom(FORM, []);
  assert.ok(!('defaultModel' in c));
  assert.equal(defaultModelOf(c), 'claude-opus-5');
  const pinned = credentialFrom({ ...FORM, defaultModel: ' claude-sonnet-5 ' }, []);
  assert.equal(pinned.defaultModel, 'claude-sonnet-5');
  assert.equal(defaultModelOf(pinned), 'claude-sonnet-5');
});

// A blank baseUrl is legal and meaningful: it marks a credential whose harness
// supplies its own endpoint (dsh against DeepSeek's own catalog).
test('a blank endpoint and a blank secret survive as blank/null', () => {
  const c = credentialFrom({ ...EMPTY_CREDENTIAL_FORM, provider: 'deepseek' }, []);
  assert.equal(c.baseUrl, '');
  assert.equal(c.secretKey, null);
  assert.equal(c.api, 'anthropic-messages');
});

// ── presets ─────────────────────────────────────────────────────────────────

test('every preset produces a form the dialog can submit', () => {
  for (const p of CREDENTIAL_PRESETS) {
    const form = formFromPreset(p.key);
    assert.equal(typeof form.api, 'string');
    assert.ok(form.api.length > 0, `${p.key} needs an api`);
    // 'custom' deliberately fills nothing but the api — it is the blank slate.
    if (p.key !== 'custom') {
      assert.ok(form.provider.length > 0, `${p.key} should name a provider`);
      const c = credentialFrom(form, []);
      assert.ok(c.id.length > 0);
      assert.equal(c.provider, form.provider);
    }
  }
});

test('an unknown preset key falls back rather than throwing', () => {
  assert.equal(typeof formFromPreset('no-such-preset').api, 'string');
});

// ── reading the column ──────────────────────────────────────────────────────

test('an unreadable credential is dropped, not fatal', () => {
  const out = modelCredentialsOf({
    modelProviders: [
      { id: 'ok', provider: 'hyqubit', label: 'ok', api: 'anthropic-messages', baseUrl: '', models: [] },
      { id: 'no-provider' },
      { provider: 'no-id' },
      'nonsense',
    ],
  });
  assert.deepEqual(out.map((c) => c.id), ['ok']);
});

test('a missing or malformed column reads as empty', () => {
  assert.deepEqual(modelCredentialsOf(null), []);
  assert.deepEqual(modelCredentialsOf({ modelProviders: 'nope' }), []);
});

test('uniqueCredentialId never returns a taken id', () => {
  assert.equal(uniqueCredentialId('x', []), 'x');
  assert.equal(uniqueCredentialId('x', ['x', 'x-2']), 'x-3');
  // A label with nothing slug-able still yields something usable.
  assert.equal(uniqueCredentialId('!!!', []), 'endpoint');
});
