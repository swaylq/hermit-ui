import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialDefaultModel as resolveDefaultModel } from './pi-config';

test('an explicit default wins', () => {
  assert.equal(
    resolveDefaultModel({ defaultModel: 'claude-sonnet-5', models: ['claude-opus-5'] }),
    'claude-sonnet-5',
  );
});

test('blank default falls back to the head of the models list', () => {
  // The list is ordered by preference on the settings page, so its first entry
  // is the machine's best model — claude-opus-5 on this fleet.
  assert.equal(resolveDefaultModel({ models: ['claude-opus-5', 'claude-haiku-4-5'] }), 'claude-opus-5');
  assert.equal(resolveDefaultModel({ defaultModel: '   ', models: ['claude-opus-5'] }), 'claude-opus-5');
});

test('nothing configured leaves the choice to pi', () => {
  // Deliberately NOT a hardcoded model id: naming one here would name something
  // a differently-configured machine's provider may not serve.
  assert.equal(resolveDefaultModel({}), undefined);
  assert.equal(resolveDefaultModel({ models: [] }), undefined);
});

test('surrounding whitespace does not become part of the model id', () => {
  assert.equal(resolveDefaultModel({ defaultModel: '  claude-opus-5  ' }), 'claude-opus-5');
  assert.equal(resolveDefaultModel({ models: ['  claude-opus-5  '] }), 'claude-opus-5');
});
