import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envVarForProvider, providerEnv, subscriptionTokenEnv } from './pi-credentials';

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

test('cc-subscription env uses ANTHROPIC_OAUTH_TOKEN so pi-ai\'s OAuth branch fires', () => {
  // pi-ai only takes its stealth-OAuth path when the token reaches createClient
  // as `apiKey` (checked via apiKey.includes("sk-ant-oat")). ANTHROPIC_AUTH_TOKEN
  // resolves to a plain Authorization header instead, which never enters that
  // branch — the exact 429-without-unified-header failure this guards against.
  assert.deepEqual(subscriptionTokenEnv('sk-ant-oat01-test-token'), {
    ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-test-token',
  });
});

test('a non-OAuth token still maps to ANTHROPIC_OAUTH_TOKEN (prefix guard is a warning only)', () => {
  // The env is set regardless; whether pi routes the request through the OAuth
  // branch is pi-ai's decision, so the guard can only warn.
  assert.deepEqual(subscriptionTokenEnv('sk-ant-api03-xxxx'), {
    ANTHROPIC_OAUTH_TOKEN: 'sk-ant-api03-xxxx',
  });
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
