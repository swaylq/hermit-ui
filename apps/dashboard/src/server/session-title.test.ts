import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExcerpt, cleanTitle, hasChinese, shouldRefresh, TITLE_MAX } from './session-title';

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

// The refresh gate, counted in USER messages: a session can log hundreds of
// tool rows without being asked anything new, and none of that changes what it
// is for.
test('a session titled before we tracked user counts refreshes once', () => {
  assert.equal(shouldRefresh(null, 3), true);
});

test('refreshes every five user messages', () => {
  assert.equal(shouldRefresh(10, 14), false);
  assert.equal(shouldRefresh(10, 15), true);
});

test('the gate does not scale with session size', () => {
  // Five real requests re-title a session however long it already is.
  assert.equal(shouldRefresh(2, 7), true);
  assert.equal(shouldRefresh(500, 505), true);
});

test('reopening with nothing new costs nothing', () => {
  assert.equal(shouldRefresh(7, 7), false);
});

test('never refreshes backwards', () => {
  assert.equal(shouldRefresh(20, 5), false);
});

// What gets sent to the model.
test('a short session is included whole, oldest first', () => {
  assert.equal(buildExcerpt(['first ask', 'second ask', 'third ask']), 'first ask\n\nsecond ask\n\nthird ask');
});

test('an over-long single message is clipped, not dropped', () => {
  const out = buildExcerpt(['x'.repeat(5000)]);
  assert.ok(out.length > 0);
  assert.ok(out.length <= 4001, `got ${out.length}`);
});

test('when the whole set will not fit, the RECENT asks are kept', () => {
  // Where the conversation got to matters more than how it opened.
  const many = Array.from({ length: 60 }, (_, i) => `ask ${i} ` + 'y'.repeat(300));
  const out = buildExcerpt(many);
  assert.ok(out.includes('ask 59'), 'latest message missing');
  assert.ok(!out.includes('ask 0 '), 'oldest message should have been dropped');
});

test('order is preserved even after trimming', () => {
  const many = Array.from({ length: 40 }, (_, i) => `ask ${i} ` + 'z'.repeat(300));
  const out = buildExcerpt(many);
  const idx = [...out.matchAll(/ask (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});

test('empty input produces an empty excerpt', () => {
  assert.equal(buildExcerpt([]), '');
});

// Titles are always Chinese. This is the check that catches a model answering in
// English anyway, so it has to be right about the edges.
test('recognises Chinese', () => {
  assert.equal(hasChinese('修复滚动跳变'), true);
  assert.equal(hasChinese('Postgres 索引调优'), true); // mixed is fine — identifiers may stay Latin
  assert.equal(hasChinese('会'), true);
});

test('rejects an answer with no Chinese at all', () => {
  assert.equal(hasChinese('Scoped CSS divider fix'), false);
  assert.equal(hasChinese('Documenting divider gotcha'), false);
  assert.equal(hasChinese(''), false);
  assert.equal(hasChinese('123 — !?'), false);
});

test('kana alone is not Chinese', () => {
  // A Japanese answer is as wrong here as an English one.
  assert.equal(hasChinese('スクロール修正'), true); // contains 修正, kanji → accepted
  assert.equal(hasChinese('スクロール'), false);
});

test('full-width punctuation alone does not count as Chinese', () => {
  assert.equal(hasChinese('（）：、'), false);
});
