// The dictation text rules — joining sentences, and a run's claim on the draft.
//
// The claim tests are the ones that matter: a dictation run rewrites a suffix of
// the draft several times a second while the user may also be typing in it, and
// every way that can go wrong is silent (text vanishes, or the run stops landing
// and the bar appears frozen). So each interference case gets a test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { joinSegments, foldTail, newClaim, replaceTail, worthRefining, type DictationClaim } from './dictation-text';

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

test('an emptied tail hands back the draft, not the draft plus a separator', () => {
  // Cancelling a run. The space that was added to hang the dictation off is not
  // the user's, and must not be left behind.
  let claim = newClaim();
  let draft = '先打了几个字';
  ({ draft, claim } = foldTail(claim, draft, '说的第一句。'));
  assert.equal(draft, '先打了几个字 说的第一句。');
  ({ draft, claim } = foldTail(claim, draft, ''));
  assert.equal(draft, '先打了几个字');
});

test('dictation can resume after being emptied', () => {
  let claim = newClaim();
  let draft = '前缀';
  ({ draft, claim } = foldTail(claim, draft, '一句。'));
  ({ draft, claim } = foldTail(claim, draft, ''));
  assert.equal(draft, '前缀');
  ({ draft, claim } = foldTail(claim, draft, '重来一句。'));
  assert.equal(draft, '前缀 重来一句。');
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

// ── the end-of-run refine landing ───────────────────────────────────────────
// The failure these guard against is the passage appearing TWICE: the refine
// comes back while the draft has moved on, and something appends it.

test('the refine replaces the run\'s tail and leaves the base alone', () => {
  const { draft, claim } = foldTail(newClaim(), '先打了几个字', '把这个。改一下。');
  assert.equal(draft, '先打了几个字 把这个。改一下。');
  const r = replaceTail(claim, draft, '把这个改一下。');
  assert.equal(r.applied, true);
  assert.equal(r.draft, '先打了几个字 把这个改一下。');
  // …and the claim now describes what is actually on screen.
  assert.equal(r.claim.rendered, r.draft);
});

test('a refine that lands after the user edited the draft is dropped', () => {
  const { draft, claim } = foldTail(newClaim(), '', '把这个。改一下。');
  const edited = `${draft} 还有别的`;
  const r = replaceTail(claim, edited, '把这个改一下。');
  assert.equal(r.applied, false);
  assert.equal(r.draft, edited); // their text, untouched — not appended to
});

test('a refine that lands after the draft was sent is dropped', () => {
  const { draft, claim } = foldTail(newClaim(), '', '把这个。改一下。');
  assert.equal(replaceTail(claim, '', '把这个改一下。').applied, false);
  assert.notEqual(draft, '');
});

test('a refine for a run that never wrote anything is dropped', () => {
  const r = replaceTail(newClaim(), '手打的字', '凭空来的一句');
  assert.equal(r.applied, false);
  assert.equal(r.draft, '手打的字');
});

test('replacing twice with the same passage is idempotent', () => {
  const { draft, claim } = foldTail(newClaim(), '基础', '一句。两句。');
  const once = replaceTail(claim, draft, '一句，两句。');
  const twice = replaceTail(once.claim, once.draft, '一句，两句。');
  assert.equal(twice.draft, once.draft);
  assert.deepEqual(twice.claim, once.claim);
});

// ── when the pass is worth making ───────────────────────────────────────────

test('a short utterance is not a passage', () => {
  assert.equal(worthRefining('继续'), false);
  assert.equal(worthRefining('把隧道重启一下。'), false);
  assert.equal(worthRefining('   '), false);
});

test('two closed sentences mean two blind corrections — refine', () => {
  assert.equal(worthRefining('把这个改一下。然后看看日志。还有证书。'), true);
});

test('one long sentence can be mangled on its own', () => {
  assert.equal(worthRefining('把那个部署脚本里面自动拉取代码然后构建镜像再推送到仓库的那一段整个重写一遍'), true);
});

test('a punctuated-but-tiny utterance is still not a passage', () => {
  // Two breaks, seven characters. The break count alone would refine this.
  assert.equal(worthRefining('好的。就这样。'), false);
});
