// The dictation text rules — joining sentences, and a run's claim on the draft.
//
// The claim tests are the ones that matter: a dictation run rewrites a suffix of
// the draft several times a second while the user may also be typing in it, and
// every way that can go wrong is silent (text vanishes, or the run stops landing
// and the bar appears frozen). So each interference case gets a test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { joinSegments, foldTail, newClaim, type DictationClaim } from './dictation-text';

test('sentences abut directly — ASR punctuates its own output', () => {
  assert.equal(
    joinSegments(['把隧道重启一下。', '然后看看日志。']),
    '把隧道重启一下。然后看看日志。',
  );
});

test('a space goes in only where two Latin words would weld together', () => {
  assert.equal(joinSegments(['restart rathole', 'then check the logs']), 'restart rathole then check the logs');
  assert.equal(joinSegments(['重启 rathole。', 'then check']), '重启 rathole。then check');
});

test('empty sentences are skipped, not turned into separators', () => {
  assert.equal(joinSegments(['a', '', 'b']), 'a b');
  assert.equal(joinSegments([]), '');
});

test('an untouched draft is left alone until the first sentence lands', () => {
  const r = foldTail(newClaim(), '已经打好的字', '');
  assert.equal(r.draft, '已经打好的字');
  assert.equal(r.claim.base, null);
});

test('the first sentence appends after what was already typed', () => {
  const r = foldTail(newClaim(), '看一下', '这个仓库的日志。');
  assert.equal(r.draft, '看一下 这个仓库的日志。');
  assert.equal(r.claim.base, '看一下 ');
});

test('an empty draft grows no leading space', () => {
  const r = foldTail(newClaim(), '', '第一句。');
  assert.equal(r.draft, '第一句。');
  assert.equal(r.claim.base, '');
});

test('the tail is rewritten whole — a correction replaces, never appends', () => {
  let claim: DictationClaim = newClaim();
  let draft = '';
  ({ draft, claim } = foldTail(claim, draft, '把pady重启一下。'));
  assert.equal(draft, '把pady重启一下。');
  // …and the polish for that same sentence lands
  ({ draft, claim } = foldTail(claim, draft, '把 caddy 重启一下。'));
  assert.equal(draft, '把 caddy 重启一下。');
});

test('a later sentence extends the tail without disturbing the earlier one', () => {
  let claim: DictationClaim = newClaim();
  let draft = '前缀';
  ({ draft, claim } = foldTail(claim, draft, '第一句。'));
  ({ draft, claim } = foldTail(claim, draft, '第一句。第二句。'));
  assert.equal(draft, '前缀 第一句。第二句。');
});

test('text typed mid-run is kept — it becomes the new base, not overwritten', () => {
  let claim: DictationClaim = newClaim();
  let draft = '';
  ({ draft, claim } = foldTail(claim, draft, '第一句。'));
  // the user types at the end while sentence two is still being spoken
  draft = `${draft}手打的字`;
  ({ draft, claim } = foldTail(claim, draft, '第一句。第二句。'));
  assert.ok(draft.includes('手打的字'), 'the typed text survived');
  assert.equal(draft, '第一句。手打的字 第一句。第二句。');
});

test('an edit that deletes part of the dictation is respected, not undone', () => {
  let claim: DictationClaim = newClaim();
  let draft = '';
  ({ draft, claim } = foldTail(claim, draft, '第一句。第二句。'));
  draft = '第一句。'; // the user deleted the second sentence
  ({ draft, claim } = foldTail(claim, draft, '第一句。第二句。第三句。'));
  assert.equal(draft, '第一句。 第一句。第二句。第三句。');
});

test('folding the same tail twice changes nothing (React may double-invoke)', () => {
  const claim = newClaim();
  const once = foldTail(claim, '基础', '一句。');
  const twice = foldTail(once.claim, once.draft, '一句。');
  assert.equal(twice.draft, once.draft);
  assert.deepEqual(twice.claim, once.claim);
});

test('re-running an updater against the ORIGINAL draft is idempotent too', () => {
  // React can call the same updater twice with the same input; the second call
  // must land on the same string as the first, or the draft flickers.
  const claim = newClaim();
  const a = foldTail(claim, '基础', '一句。');
  const b = foldTail(claim, '基础', '一句。');
  assert.equal(a.draft, b.draft);
});
