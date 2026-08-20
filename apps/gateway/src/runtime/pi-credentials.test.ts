import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  envVarForProvider, fingerprintAuthEnv, providerEnv,
} from './pi-credentials';

test('provider name maps onto the store key convention', () => {
  assert.equal(envVarForProvider('openrouter'), 'OPENROUTER_API_KEY');
  assert.equal(envVarForProvider('deepseek'), 'DEEPSEEK_API_KEY');
  // pi has hyphenated provider ids (zai-coding-cn, qwen-token-plan); env vars
  // cannot contain hyphens, so they normalise to underscores.
  assert.equal(envVarForProvider('zai-coding-cn'), 'ZAI_CODING_CN_API_KEY');
});

test('built-in moonshot providers read MOONSHOT_API_KEY, not the convention name', () => {
  // pi's own env map (pi-ai env-api-keys.js) keys moonshotai-cn to
  // MOONSHOT_API_KEY; the gateway must hand the child the same env var.
  assert.equal(envVarForProvider('moonshotai'), 'MOONSHOT_API_KEY');
  assert.equal(envVarForProvider('moonshotai-cn'), 'MOONSHOT_API_KEY');
  assert.equal(envVarForProvider('kimi-coding'), 'KIMI_API_KEY');
  assert.equal(envVarForProvider('huggingface'), 'HF_TOKEN');
});

// The Claude Code subscription path used to live here: a Keychain OAuth token
// injected as ANTHROPIC_OAUTH_TOKEN so pi-ai took its stealth-OAuth branch. It
// worked, and it is gone deliberately — see the note in pi-credentials.ts. What
// remains testable is that no credential path can produce that env var again.
test('no credential path emits an Anthropic OAuth token', () => {
  assert.equal(fingerprintAuthEnv({ ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-x' }), null);
});

test('no provider means no injected env', async () => {
  assert.deepEqual(await providerEnv(null), {});
  assert.deepEqual(await providerEnv(undefined), {});
  assert.deepEqual(await providerEnv(''), {});
});

test('a provider name that could reach the shell is rejected outright', async () => {
  // Defence in depth: execFile already takes no shell, but a name like this
  // should never even become a secret lookup.
  assert.deepEqual(await providerEnv('foo; rm -rf /'), {});
  assert.deepEqual(await providerEnv('$(whoami)'), {});
  assert.deepEqual(await providerEnv('a b'), {});
});

test('an unknown provider degrades to the gateway env instead of throwing', async () => {
  const out = await providerEnv('definitely-not-a-real-provider-xyz');
  assert.deepEqual(out, {});
});

// The fingerprint is how a runtime notices its child is holding a credential
// that has since been rotated away — the failure that wedged sway003 and
// macmini003 for ~9h each with 401 "OAuth access token has been revoked".
test('a rotated credential produces a different fingerprint', () => {
  const before = fingerprintAuthEnv({ HERMIT_PI_API_KEY: 'key-one' });
  const after = fingerprintAuthEnv({ HERMIT_PI_API_KEY: 'key-two' });
  assert.ok(before);
  assert.notEqual(before, after);
});

test('the same credential fingerprints identically, so a live child is left alone', () => {
  const env = { HERMIT_PI_API_KEY: 'key-same' };
  assert.equal(fingerprintAuthEnv(env), fingerprintAuthEnv({ ...env }));
});

// It ends up in logs and in an eviction reason shown to the user, so it must
// not be possible to read the credential back out of it.
test('the fingerprint never carries the secret itself', () => {
  const secret = 'SUPERSECRET-VALUE-1234';
  const fp = fingerprintAuthEnv({ HERMIT_PI_API_KEY: secret })!;
  assert.ok(!fp.includes(secret));
  assert.ok(!fp.includes('SUPERSECRET'));
  assert.match(fp, /^HERMIT_PI_API_KEY:[0-9a-f]{12}$/);
});

// Null is the "do not check" signal: a machine that configures no credential
// hands its children the gateway's own env, and must not be told its sessions
// rotate on every tick.
test('no credential means no fingerprint, which disables the staleness check', () => {
  assert.equal(fingerprintAuthEnv({}), null);
  // Non-credential config moving is not a reason to recycle a conversation.
  assert.equal(fingerprintAuthEnv({
    HERMIT_PI_PROVIDER: 'hyqubit',
    HERMIT_PI_BASE_URL: 'https://litellm.hyqubit.com',
    HERMIT_PI_MODELS: 'claude-opus-5',
  }), null);
});

// Only credential-bearing names are hashed, and only the ones AUTH_ENV_KEYS
// lists. A second key alongside the credential — a provider's own env var, say
// — must not change the answer, or every boot would look like a rotation.
test('the fingerprint reads only the credential, whatever else is in the env', () => {
  const fp = fingerprintAuthEnv({
    HERMIT_PI_API_KEY: 'k',
    MOONSHOT_API_KEY: 'other',
    HERMIT_PI_PROVIDER: 'hyqubit',
  })!;
  assert.match(fp, /^HERMIT_PI_API_KEY:[0-9a-f]{12}$/);
  assert.equal(fp, fingerprintAuthEnv({ HERMIT_PI_API_KEY: 'k' }));
});
