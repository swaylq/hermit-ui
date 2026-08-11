import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowFor, codexContextWindow, DEFAULT_CONTEXT_WINDOW, CODEX_DEFAULT_WINDOW,
} from './context-window';

// 258,400 is not a guess: codex reports context_window 272,000 with
// effective_context_window_percent 95, and 272000 * 0.95 = 258400 is exactly the
// `model_context_window` its rollout files record.
test('the current codex default model gets its real window', () => {
  assert.equal(codexContextWindow('gpt-5.6-sol'), 258_400);
  assert.equal(codexContextWindow('gpt-5.6-terra'), 258_400);
  assert.equal(codexContextWindow('gpt-5.6-luna'), 258_400);
});

test('a suffixed release resolves by prefix', () => {
  assert.equal(codexContextWindow('gpt-5.6-sol-wm'), 258_400);
});

// The one model with a genuinely different window. If the prefix table were
// ordered shortest-first this would silently pick up a 5.3 entry instead.
test('the small model gets its own smaller window', () => {
  assert.equal(codexContextWindow('gpt-5.3-codex-spark'), 121_600);
});

test('older frontier models keep the 272k family window', () => {
  assert.equal(codexContextWindow('gpt-5.5'), 258_400);
  assert.equal(codexContextWindow('gpt-5.4'), 258_400);
  assert.equal(codexContextWindow('gpt-5.4-mini'), 258_400);
});

// A session that pins no model runs the fleet default, which is a 272k model.
test('an unnamed or unknown model gets the codex default, not 1M', () => {
  assert.equal(codexContextWindow(null), CODEX_DEFAULT_WINDOW);
  assert.equal(codexContextWindow(''), CODEX_DEFAULT_WINDOW);
  assert.equal(codexContextWindow('gpt-6-something-unreleased'), CODEX_DEFAULT_WINDOW);
  assert.notEqual(CODEX_DEFAULT_WINDOW, DEFAULT_CONTEXT_WINDOW);
});

test('case and whitespace do not change the answer', () => {
  assert.equal(codexContextWindow('  GPT-5.6-Sol '), 258_400);
});

// The bug this fixes: every backend divided by 1,000,000, so a codex session at
// 60% occupancy rendered as a comfortable 15%.
test('a codex session no longer divides by a claude window', () => {
  assert.equal(contextWindowFor('codex-exec', 'gpt-5.6-sol'), 258_400);
  assert.equal(contextWindowFor('codex-exec', null), CODEX_DEFAULT_WINDOW);
});

// Deliberately unchanged — see the note in context-window.ts about pi.
test('claude and pi keep the previous denominator', () => {
  assert.equal(contextWindowFor('claude-tmux', null), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor('pi-rpc', 'claude-opus-5'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor(null, null), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor(undefined, undefined), DEFAULT_CONTEXT_WINDOW);
});
