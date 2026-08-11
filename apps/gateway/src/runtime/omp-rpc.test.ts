import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureOmpModelsYaml } from './omp-rpc';

// omp resolves providers from ~/.omp/agent/models.yml. The file is generated
// from Settings → Pi Runtime, and each model has to carry its own window: omp's
// catalog is keyed by provider as well as model id, so a machine-declared
// provider matches nothing and the engine falls back to a 128k guess.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omp-models-'));
}

function read(dir: string): string {
  return fs.readFileSync(path.join(dir, 'models.yml'), 'utf8');
}

test('ensureOmpModelsYaml writes the provider with an env apiKey reference', () => {
  const dir = tmpDir();
  ensureOmpModelsYaml({ provider: 'hyqubit', baseUrl: 'https://litellm.hyqubit.com', models: ['claude-opus-5'] }, dir);
  const yaml = read(dir);
  assert.match(yaml, /^ {2}hyqubit:$/m);
  assert.match(yaml, /baseUrl: "https:\/\/litellm\.hyqubit\.com"/);
  assert.match(yaml, /apiKey: HERMIT_PI_API_KEY/);
  assert.match(yaml, /- id: "claude-opus-5"/);
});

test('ensureOmpModelsYaml states each model context window and output cap', () => {
  const dir = tmpDir();
  ensureOmpModelsYaml(
    { provider: 'hyqubit', baseUrl: 'https://litellm.hyqubit.com', models: ['claude-opus-5', 'kimi-k3'] },
    dir,
  );
  const yaml = read(dir);
  assert.match(yaml, /contextWindow: 1000000/);
  assert.match(yaml, /maxTokens: 128000/);
  // One known model means exactly one pair of limit lines; the unknown model is
  // left for omp to decide rather than pinned to a made-up number.
  assert.equal(yaml.match(/contextWindow:/g)?.length, 1);
});

test('ensureOmpModelsYaml lets a machine override the limits table', () => {
  const dir = tmpDir();
  ensureOmpModelsYaml(
    {
      provider: 'hyqubit',
      baseUrl: 'https://litellm.hyqubit.com',
      models: ['kimi-k3'],
      modelLimits: { 'kimi-k3': { contextWindow: 256_000 } },
    },
    dir,
  );
  assert.match(read(dir), /contextWindow: 256000/);
});

test('ensureOmpModelsYaml leaves a hand-written file alone', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'models.yml');
  fs.writeFileSync(file, 'providers:\n  mine:\n    baseUrl: "https://example.test"\n');
  ensureOmpModelsYaml({ provider: 'hyqubit', baseUrl: 'https://litellm.hyqubit.com' }, dir);
  assert.match(fs.readFileSync(file, 'utf8'), /mine:/);
});

test('ensureOmpModelsYaml skips when there is no provider or baseUrl', () => {
  const dir = tmpDir();
  ensureOmpModelsYaml({}, dir);
  ensureOmpModelsYaml({ provider: 'anthropic' }, dir);
  assert.equal(fs.existsSync(path.join(dir, 'models.yml')), false);
});
