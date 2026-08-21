import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_CLAUDE_MODELS, claudeModelsOf, modelPinOf, shortModelLabel, modelChipLabel,
} from './claude-models';

test('a machine that has never reported gets the fallback list', () => {
  assert.equal(claudeModelsOf(null), FALLBACK_CLAUDE_MODELS);
  assert.equal(claudeModelsOf({}), FALLBACK_CLAUDE_MODELS);
  assert.equal(claudeModelsOf({ claudeModels: 'not an array' }), FALLBACK_CLAUDE_MODELS);
  // An array with nothing usable in it is the same case: a picker rendering
  // zero rows is worse than one a release behind.
  assert.equal(claudeModelsOf({ claudeModels: [{ displayName: 'no value' }] }), FALLBACK_CLAUDE_MODELS);
});

test('a reported catalogue is taken as-is, minus the rows that cannot render', () => {
  const models = claudeModelsOf({
    claudeModels: [
      { value: ' sonnet ', displayName: ' Sonnet ', description: '  Efficient  ' },
      { value: 'opus[1m]', displayName: '' },   // no name → falls back to the value
      { value: '' },                            // no id → unusable
      null,
    ],
  });
  assert.deepEqual(models, [
    { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient' },
    { value: 'opus[1m]', displayName: 'opus[1m]' },
  ]);
});

// "default" is the CLI's word for "no pin", and the column's word for it is
// null. One spelling of unset end to end is what lets un-picking a model reach
// the SDK as setModel(undefined) instead of setModel('default').
test('the default row pins nothing', () => {
  assert.equal(modelPinOf('default'), null);
  assert.equal(modelPinOf(''), null);
  assert.equal(modelPinOf('  '), null);
  assert.equal(modelPinOf(null), null);
  assert.equal(modelPinOf(' sonnet '), 'sonnet');
});

test('chip labels drop the parenthetical the menu has room for', () => {
  assert.equal(shortModelLabel('Opus (1M context)'), 'Opus');
  assert.equal(shortModelLabel('Default (recommended)'), 'Default');
  assert.equal(shortModelLabel('Sonnet'), 'Sonnet');
  // Nothing left after the trim → keep what we were given rather than render
  // an empty chip.
  assert.equal(shortModelLabel('(1M)'), '(1M)');
});

test('a pin the machine no longer offers still renders as itself', () => {
  const models = [{ value: 'default', displayName: 'Default (recommended)' }, { value: 'sonnet', displayName: 'Sonnet' }];
  assert.equal(modelChipLabel('sonnet', models), 'Sonnet');
  assert.equal(modelChipLabel(null, models), 'Default');
  // The model was pinned before an upgrade dropped it. Showing the raw id is
  // the only answer that does not claim the session runs something else.
  assert.equal(modelChipLabel('claude-fable-5[1m]', models), 'claude-fable-5[1m]');
  // No catalogue at all (a machine mid-first-report) still labels the chip.
  assert.equal(modelChipLabel(null, []), 'Default');
});
