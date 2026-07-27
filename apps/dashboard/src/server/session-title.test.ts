import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, shouldRefresh, TITLE_MAX } from './session-title';

test('strips the wrappers models add', () => {
  assert.equal(cleanTitle('“本地聊天缓存方案”'), '本地聊天缓存方案');
  assert.equal(cleanTitle('"Postgres index tuning"'), 'Postgres index tuning');
  assert.equal(cleanTitle('标题：滚动跳变修复'), '滚动跳变修复');
  assert.equal(cleanTitle('Title: Scroll anchoring'), 'Scroll anchoring');
  assert.equal(cleanTitle('「会话标题」'), '会话标题');
});

test('takes only the first line and drops trailing punctuation', () => {
  assert.equal(cleanTitle('修复滚动跳变。\n\n这个标题概括了…'), '修复滚动跳变');
  assert.equal(cleanTitle('Fix the scroll jump!'), 'Fix the scroll jump');
});

test('clamps to the maximum length', () => {
  const long = '很'.repeat(200);
  assert.equal(cleanTitle(long).length, TITLE_MAX);
});

test('empty in, empty out — the caller falls back to the preview', () => {
  assert.equal(cleanTitle('   '), '');
  assert.equal(cleanTitle('""'), '');
});

// The refresh gate is the whole token-cost story: it decides how often a
// long-running session is re-read by the model.
test('a session titled before counts were tracked refreshes once', () => {
  assert.equal(shouldRefresh(null, 12), true);
});

test('does not refresh until the conversation has really moved on', () => {
  assert.equal(shouldRefresh(10, 11), false);
  assert.equal(shouldRefresh(10, 20), false); // doubled, but only +10
  assert.equal(shouldRefresh(10, 49), false); // +39, one short
  assert.equal(shouldRefresh(10, 50), true); // doubled AND +40
});

test('a big session needs proportionally more growth, not a fixed amount', () => {
  assert.equal(shouldRefresh(1000, 1200), false);
  assert.equal(shouldRefresh(1000, 2000), true);
});

test('refreshes stay logarithmic over a session lifetime', () => {
  // The cost bound that justifies calling autoTitle on every open.
  let titledAt = 4;
  let calls = 0;
  for (let n = 4; n <= 30_000; n++) {
    if (shouldRefresh(titledAt, n)) {
      calls++;
      titledAt = n;
    }
  }
  assert.ok(calls <= 12, `expected a handful of refreshes over 30k messages, got ${calls}`);
  assert.ok(calls >= 5, `expected the title to keep up at all, got ${calls}`);
});

test('never refreshes backwards', () => {
  assert.equal(shouldRefresh(100, 50), false);
});
