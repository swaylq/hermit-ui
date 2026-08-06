import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envVarForProvider, providerEnv } from './pi-credentials';

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
