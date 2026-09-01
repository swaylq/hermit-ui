import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelLimitsFor } from './pi-model-limits';

// The bug these guard: a model declared under a machine's own provider matches
// nothing in pi's catalog, so pi sizes max_tokens against a 128k window it made
// up and truncates the reply mid-sentence once the prompt passes ~124k.

test('a 1M-context model gets its real window, not the engine default', () => {
  assert.deepEqual(modelLimitsFor('claude-opus-5'), { contextWindow: 1_000_000, maxTokens: 128_000 });
  assert.deepEqual(modelLimitsFor('claude-sonnet-5'), { contextWindow: 1_000_000, maxTokens: 128_000 });
});

test('haiku keeps its own smaller window', () => {
  assert.deepEqual(modelLimitsFor('claude-haiku-4-5'), { contextWindow: 200_000, maxTokens: 64_000 });
});

test('dated releases and vendor-prefixed ids resolve to their family', () => {
  assert.deepEqual(modelLimitsFor('claude-haiku-4-5-20251001'), { contextWindow: 200_000, maxTokens: 64_000 });
  assert.deepEqual(modelLimitsFor('anthropic/claude-opus-5'), { contextWindow: 1_000_000, maxTokens: 128_000 });
});

test('an unknown model gets nothing, leaving the engine its own default', () => {
  assert.deepEqual(modelLimitsFor('kimi-k3'), {});
  assert.deepEqual(modelLimitsFor(''), {});
});

test('a machine override wins over the table, field by field', () => {
  assert.deepEqual(modelLimitsFor('claude-opus-5', { 'claude-opus-5': { contextWindow: 200_000 } }), {
    contextWindow: 200_000,
    maxTokens: 128_000,
  });
  assert.deepEqual(modelLimitsFor('kimi-k3', { 'kimi-k3': { contextWindow: 256_000, maxTokens: 32_000 } }), {
    contextWindow: 256_000,
    maxTokens: 32_000,
  });
});

// An override comes out of a Json column, so it is only as well-typed as
// whatever last wrote it. A 0 or a string pinned as the window would be worse
// than the guess this whole module replaces.
test('a malformed override falls back to the table instead of pinning nonsense', () => {
  const bad = { 'claude-opus-5': { contextWindow: 0, maxTokens: -5 } };
  assert.deepEqual(modelLimitsFor('claude-opus-5', bad), { contextWindow: 1_000_000, maxTokens: 128_000 });

  const stringly = { 'claude-opus-5': { contextWindow: '900000' } } as unknown as Record<
    string,
    { contextWindow?: number }
  >;
  assert.deepEqual(modelLimitsFor('claude-opus-5', stringly), { contextWindow: 1_000_000, maxTokens: 128_000 });
});

test('an override for an unknown model still leaves unset fields unset', () => {
  assert.deepEqual(modelLimitsFor('kimi-k3', { 'kimi-k3': { maxTokens: 8_000 } }), { maxTokens: 8_000 });
});

test('the kimi families resolve, longest prefix first', () => {
  assert.deepEqual(modelLimitsFor('k3'), { contextWindow: 1_048_576, maxTokens: 131_072 });
  assert.deepEqual(modelLimitsFor('k3-256k'), { contextWindow: 262_144, maxTokens: 131_072 });
  assert.deepEqual(modelLimitsFor('kimi-for-coding'), { contextWindow: 262_144, maxTokens: 131_072 });
  assert.deepEqual(modelLimitsFor('kimi-for-coding-highspeed'), { contextWindow: 262_144, maxTokens: 131_072 });
});
