import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeCredentialEnv, applyCredentialEnv, isClaudeCompatible,
  CLAUDE_MODEL_SLOTS,
} from './claude-credentials';

const KIMI = {
  id: 'kimi-code',
  label: 'Kimi Code',
  provider: 'kimi-coding',
  api: 'anthropic-messages',
  baseUrl: 'https://api.kimi.com/coding',
  models: ['k3', 'k3-256k'],
  defaultModel: 'k3',
  secretKey: 'KIMI_API_KEY',
};

test('the built-in backend gets nothing — no credential, no env', () => {
  assert.deepEqual(claudeCredentialEnv(null, 'sk-x', 'k3'), {});
  assert.deepEqual(claudeCredentialEnv(undefined, null, null), {});
});

test('a credential whose secret the store does not hold gets nothing', () => {
  // The alternative is a child that boots with a base URL and no token and
  // 401s at the first message with nothing on screen to explain it.
  assert.deepEqual(claudeCredentialEnv(KIMI, null, 'k3'), {});
});

test('an OpenAI-shaped credential is refused', () => {
  // Claude Code speaks one protocol. Pairing it with OpenRouter would 404 at
  // the first message.
  const openrouter = { ...KIMI, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' };
  assert.equal(isClaudeCompatible(openrouter), false);
  assert.deepEqual(claudeCredentialEnv(openrouter, 'sk-x', 'x'), {});
});

test('a credential with no endpoint is refused', () => {
  // Blank baseUrl is the catalog's marker for "this harness supplies its own"
  // (dsh against DeepSeek). Claude Code has no such thing.
  assert.equal(isClaudeCompatible({ ...KIMI, baseUrl: '' }), false);
});

test('an anthropic credential yields the endpoint, the token and every model slot', () => {
  const env = claudeCredentialEnv(KIMI, 'sk-kimi-secret', 'k3[1m]');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.kimi.com/coding');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-kimi-secret');
  // Every slot, not just ANTHROPIC_MODEL: the CLI reaches for a small model to
  // title a chat and for a named family to run a subagent, and api.kimi.com
  // answers an unknown id instead of rejecting it — so an unset slot bills a
  // model the header never named.
  for (const slot of CLAUDE_MODEL_SLOTS) assert.equal(env[slot], 'k3[1m]', slot);
});

test('no model pinned falls through to the credential default', () => {
  assert.equal(claudeCredentialEnv(KIMI, 'sk-x', null).ANTHROPIC_MODEL, 'k3');
  assert.equal(claudeCredentialEnv(KIMI, 'sk-x', '   ').ANTHROPIC_MODEL, 'k3');
});

test('K3 runs at max effort', () => {
  // Same setting the built-in backend already runs; K3 cannot turn thinking
  // off, so the only question is how much is asked for.
  assert.equal(claudeCredentialEnv(KIMI, 'sk-x', 'k3').CLAUDE_CODE_EFFORT_LEVEL, 'max');
});

test('a context window is only stated when the credential knows one', () => {
  const plain = claudeCredentialEnv(KIMI, 'sk-x', 'k3');
  assert.equal(plain.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(plain.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);

  const sized = claudeCredentialEnv(
    { ...KIMI, modelLimits: { k3: { contextWindow: 1_048_576 } } }, 'sk-x', 'k3',
  );
  assert.equal(sized.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
  assert.equal(sized.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1048576');
});

test('a window is keyed by the model actually running, not the default', () => {
  const c = { ...KIMI, modelLimits: { k3: { contextWindow: 1_048_576 }, 'k3-256k': { contextWindow: 262_144 } } };
  assert.equal(claudeCredentialEnv(c, 'sk-x', 'k3-256k').CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
});

test('applying a credential removes the auth variable that would fight it', () => {
  // Two spellings of one slot: the CLI warns rather than picking, so the
  // inherited one is deleted from the child's copy. Overwriting is not enough
  // — both would still be set.
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'the-machine-subscription', PATH: '/bin' };
  applyCredentialEnv(env, claudeCredentialEnv(KIMI, 'sk-x', 'k3'));
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-x');
  assert.equal(env.PATH, '/bin');
});

test('the built-in backend keeps whatever the gateway itself carries', () => {
  // An empty credential env must be a no-op, or every subscription session on
  // a machine with ANTHROPIC_API_KEY exported would lose it.
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'keep-me' };
  applyCredentialEnv(env, {});
  assert.equal(env.ANTHROPIC_API_KEY, 'keep-me');
});
