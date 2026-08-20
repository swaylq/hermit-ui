import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDshCommand, piEndpointRoute, inferDshSelection, hermitPatchYaml } from './dsh-exec';

// The usage arithmetic (totalTokens / lastCallUsage) is covered beside the
// translator in dsh-events.test.ts; the spawn path itself is exercised against
// a real dsh install by scripts/dsh-e2e.mts, not here.

test('HERMIT_DSH_BIN pointing at a js file runs it with node', () => {
  const cmd = resolveDshCommand({ HERMIT_DSH_BIN: '/opt/dsh/lib/bin.js' } as NodeJS.ProcessEnv);
  assert.equal(cmd?.cmd, process.execPath);
  assert.deepEqual(cmd?.args, ['/opt/dsh/lib/bin.js']);
});

test('HERMIT_DSH_BIN naming a binary runs it as itself', () => {
  // A machine with dsh on PATH sets HERMIT_DSH_BIN=dsh.
  assert.deepEqual(resolveDshCommand({ HERMIT_DSH_BIN: 'dsh' } as NodeJS.ProcessEnv), { cmd: 'dsh', args: [] });
  assert.deepEqual(
    resolveDshCommand({ HERMIT_DSH_BIN: '/usr/local/bin/dsh' } as NodeJS.ProcessEnv),
    { cmd: '/usr/local/bin/dsh', args: [] },
  );
});

test('a blank override falls through to the default install lookup', () => {
  // The default depends on this machine's ~/.dsh, so only the shape is pinned:
  // either dsh is installed there (node + its bin.js) or it is absent (null,
  // which submit reports into the chat instead of failing silently).
  const cmd = resolveDshCommand({ HERMIT_DSH_BIN: '  ' } as NodeJS.ProcessEnv);
  if (cmd !== null) {
    assert.equal(cmd.cmd, process.execPath);
    assert.match(cmd.args[0] ?? '', /@deepseek-ai\/dsh\/lib\/bin\.js$/);
  }
});

// ── the pi endpoint bridge ──────────────────────────────────────────────────

const HYQUBIT = {
  id: 'hyqubit',
  label: 'hyqubit',
  provider: 'hyqubit',
  baseUrl: 'https://litellm.hyqubit.com',
  api: 'anthropic-messages',
  models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  secretKey: 'LITELLM_HYQUBIT_TOKEN',
};

test('the machine pi endpoint becomes an llm-pi-ai route with real model limits', () => {
  const route = piEndpointRoute(HYQUBIT);
  assert.ok(route);
  assert.equal(route.provider, 'hyqubit');
  assert.equal(route.secretKey, 'LITELLM_HYQUBIT_TOKEN');
  assert.equal(route.defaultModel, 'claude-opus-5'); // no defaultModel set → first model
  const yaml = hermitPatchYaml('/r.mjs', route.rows);
  assert.match(yaml, /apiKeyEnv: 'LITELLM_HYQUBIT_TOKEN'/);
  assert.match(yaml, /api: 'anthropic-messages'/);
  assert.match(yaml, /baseURL: 'https:\/\/litellm\.hyqubit\.com'/);
  // claude-opus-5 must carry its 1M window: llm-pi-ai's declared-route default
  // is 256k, which would silently shrink it.
  assert.match(yaml, /id: 'claude-opus-5'\n {12}contextWindow: 1000000\n {12}maxTokens: 128000/);
  assert.match(yaml, /id: 'claude-haiku-4-5'\n {12}contextWindow: 200000/);
  // The stock-runner swap still surrounds it.
  assert.match(yaml, /- id: headless-runner\n {2}disabled: true/);
  assert.match(yaml, /name: '\/r\.mjs'/);
});

test('a configured defaultModel wins over first-in-list', () => {
  assert.equal(piEndpointRoute({ ...HYQUBIT, defaultModel: 'claude-haiku-4-5' })?.defaultModel, 'claude-haiku-4-5');
});

test('modelLimits overrides flow through to the route', () => {
  const route = piEndpointRoute({
    ...HYQUBIT,
    models: ['relay-mystery'],
    modelLimits: { 'relay-mystery': { contextWindow: 384_000 } },
  });
  assert.match(route!.rows.join('\n'), /id: 'relay-mystery'\n {12}contextWindow: 384000/);
});

test('an unknown model omits limit fields so llm-pi-ai keeps its own defaults', () => {
  const route = piEndpointRoute({ ...HYQUBIT, models: ['relay-mystery'] });
  const rows = route!.rows.join('\n');
  assert.match(rows, /id: 'relay-mystery'/);
  assert.ok(!rows.includes('contextWindow'), rows);
});

test('the legacy invalid api value openai maps to openai-completions', () => {
  const route = piEndpointRoute({ ...HYQUBIT, api: 'openai' });
  assert.match(route!.rows.join('\n'), /api: 'openai-completions'/);
});

test('an api dsh cannot speak drops the bridge, never a broken route', () => {
  // Emitting it would fail resolveProfiles at dsh boot and kill EVERY dsh turn
  // on the machine, deepseek ones included.
  assert.equal(piEndpointRoute({ ...HYQUBIT, api: 'bedrock-invoke' }), null);
});

test('an unusable endpoint is no bridge at all', () => {
  assert.equal(piEndpointRoute(null), null);
  assert.equal(piEndpointRoute({ ...HYQUBIT, baseUrl: '' }), null);
  assert.equal(piEndpointRoute({ ...HYQUBIT, provider: '' }), null);
  assert.equal(piEndpointRoute({ ...HYQUBIT, secretKey: null }), null);
  assert.equal(piEndpointRoute({ ...HYQUBIT, secretKey: 'not a var name' }), null);
  assert.equal(piEndpointRoute({ ...HYQUBIT, models: [] }), null);
});

// ── pin inference ───────────────────────────────────────────────────────────

const ROUTE = { provider: 'hyqubit', models: HYQUBIT.models, defaultModel: 'claude-opus-5' };

test('a claude model pin implies the pi endpoint provider', () => {
  assert.deepEqual(
    inferDshSelection(ROUTE, null, 'claude-sonnet-5'),
    { provider: 'hyqubit', model: 'claude-sonnet-5' },
  );
});

test('a provider pin without a model lands on the endpoint default, not deepseek-v4-flash', () => {
  assert.deepEqual(
    inferDshSelection(ROUTE, 'hyqubit', null),
    { provider: 'hyqubit', model: 'claude-opus-5' },
  );
});

test('models the endpoint does not serve stay on dsh’s own default provider', () => {
  assert.deepEqual(
    inferDshSelection(ROUTE, null, 'deepseek-v4-pro'),
    { provider: null, model: 'deepseek-v4-pro' },
  );
  assert.deepEqual(inferDshSelection(ROUTE, null, null), { provider: null, model: null });
});

test('explicit pins pass through untouched, bridge or no bridge', () => {
  assert.deepEqual(
    inferDshSelection(ROUTE, 'deepseek-official', 'deepseek-v4-pro'),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  );
  assert.deepEqual(
    inferDshSelection(null, null, 'claude-opus-5'),
    { provider: null, model: 'claude-opus-5' },
  );
});
