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

// The refresh gate. The title means "what is this session doing lately", so it
// is flat — a long session needs re-reading as often as a short one — and the
// cost is bounded by how often you OPEN a session, not by message volume.
test('a session titled before counts were tracked refreshes once', () => {
  assert.equal(shouldRefresh(null, 12), true);
});

test('a handful of new messages is not yet worth re-reading', () => {
  assert.equal(shouldRefresh(10, 11), false);
  assert.equal(shouldRefresh(10, 29), false);
});

test('refreshes once real conversation has accumulated', () => {
  assert.equal(shouldRefresh(10, 40), true);
  assert.equal(shouldRefresh(10, 500), true);
});

test('the gate does NOT scale with session size — recency matters equally at any length', () => {
  // The old proportional gate made a 1000-message session wait for another
  // 1000; a title about "lately" must not get harder to refresh over time.
  assert.equal(shouldRefresh(1000, 1030), true);
  assert.equal(shouldRefresh(10, 40), true);
});

test('reopening with nothing new costs nothing', () => {
  assert.equal(shouldRefresh(250, 250), false);
});

test('never refreshes backwards', () => {
  assert.equal(shouldRefresh(100, 50), false);
});
