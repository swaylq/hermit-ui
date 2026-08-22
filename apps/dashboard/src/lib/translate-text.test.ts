// What auto-translate is allowed to fire on, and where a reply gets cut.
//
// The cases that matter are the ones where a naive implementation is wrong in a
// way nobody notices until it ships: technical Chinese read as English (because
// by character count it nearly is), a code fence cut in half, and an
// acknowledgement translated into a flicker.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLang,
  proseOnly,
  hasProse,
  splitBlocks,
  joinBlocks,
  shouldAutoTranslate,
  canTranslate,
  blockKey,
} from './translate-text';

// ── detectLang ───────────────────────────────────────────────────────────────

test('plain English prose', () => {
  assert.equal(detectLang("Here's the root cause. The gateway upserts a placeholder row."), 'en');
});

test('plain Chinese prose', () => {
  assert.equal(detectLang('网关重启把会话杀掉了，我已经改成复用现有连接。'), 'zh');
});

test('technical Chinese is Chinese, however many identifiers it carries', () => {
  // By latin CHARACTER count this is nearly half English. Counting characters
  // instead of words is what would misfire here.
  const s = '我看了下 stream-reveal.ts，REVEAL_LAG_MS 是 550ms，backlog 大的时候 cps 会拉高，所以 typewriter 不会卡。';
  assert.equal(detectLang(s), 'zh');
});

test('a Chinese sentence wrapped around one long code block stays Chinese', () => {
  const s = '这段是问题所在：\n\n```ts\nconst LIVE_PUSH_MS = 250;\nawait db.session.upsert({ where: { id } });\n```\n\n先改这里。';
  assert.equal(detectLang(s), 'zh');
});

test('an English reply full of paths is still English', () => {
  const s = 'Check `apps/dashboard/src/lib/stream-reveal.ts:42` and then restart the gateway.';
  assert.equal(detectLang(s), 'en');
});

test('acknowledgements are `none` — nothing worth a round trip', () => {
  assert.equal(detectLang('Done.'), 'none');
  assert.equal(detectLang('OK'), 'none');
  assert.equal(detectLang('✅ deployed'), 'none');
});

test('a bare code fence has no language', () => {
  assert.equal(detectLang('```sh\npm2 restart hermit-ui-gateway\n```'), 'none');
});

test('an unclosed fence — the tail of a streaming reply — is still stripped', () => {
  assert.equal(detectLang('```ts\nconst REVEAL_LAG_MS = 550;\nconst QUIET'), 'none');
});

test('a bare URL is not English', () => {
  assert.equal(detectLang('https://dash.swaylab.ai/chat?session=abc-def-ghi'), 'none');
});

test('a link keeps its label but drops its target', () => {
  assert.match(proseOnly('see [the design note](https://example.com/a/b/c)'), /the design note/);
  assert.doesNotMatch(proseOnly('see [the design note](https://example.com/a/b/c)'), /example/);
});

test('the tally is CJK characters against latin words, and it is symmetric', () => {
  // Mixed strings are the ambiguous case. The second one is why the tally may
  // not short-circuit on "some Chinese present": an English reply that quotes
  // the user's Chinese must stay translatable.
  assert.equal(detectLang('帮我把网关重启一下 then check the gateway logs please'), 'zh');
  assert.equal(detectLang('He said 帮我重启 and then went to lunch, which is why the queue backed up.'), 'en', 'an English reply quoting Chinese is still English');
});

// ── splitBlocks ──────────────────────────────────────────────────────────────

test('blocks split on blank lines', () => {
  const b = splitBlocks('First paragraph here.\n\nSecond paragraph here.');
  assert.equal(b.length, 2);
  assert.equal(b[0].text, 'First paragraph here.');
  assert.equal(b[1].text, 'Second paragraph here.');
});

test('a fenced block is never cut, blank lines inside and all', () => {
  const src = 'Before the code.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the code.';
  const b = splitBlocks(src);
  assert.equal(b.length, 3);
  assert.equal(b[1].text, '```ts\nconst a = 1;\n\nconst b = 2;\n```');
  assert.equal(b[1].translatable, false, 'pure code is passed through, not sent to the model');
  assert.equal(b[0].translatable, true);
  assert.equal(b[2].translatable, true);
});

test('a fence opening without a blank line above it still starts its own block', () => {
  const b = splitBlocks('Run this:\n```sh\nnpm test\n```\nThen check.');
  assert.deepEqual(b.map((x) => x.text), ['Run this:', '```sh\nnpm test\n```', 'Then check.']);
  assert.deepEqual(b.map((x) => x.translatable), [true, false, true]);
});

test('a tilde fence closes only on tildes, and only on a long-enough run', () => {
  const b = splitBlocks('~~~~\nstill code ```\nstill code\n~~~~\n\nprose again');
  assert.equal(b.length, 2);
  assert.equal(b[0].text, '~~~~\nstill code ```\nstill code\n~~~~');
  assert.equal(b[1].text, 'prose again');
});

test('an unclosed fence swallows the rest — it is the tail being written', () => {
  const b = splitBlocks('Here it is:\n\n```ts\nconst a = 1;\n\nconst b = 2;');
  assert.equal(b.length, 2);
  assert.equal(b[1].text, '```ts\nconst a = 1;\n\nconst b = 2;');
});

test('runs of blank lines collapse rather than producing empty blocks', () => {
  assert.deepEqual(splitBlocks('a\n\n\n\nb').map((x) => x.text), ['a', 'b']);
  assert.deepEqual(splitBlocks('\n\n  \n').map((x) => x.text), []);
});

test('a list survives as one block', () => {
  const b = splitBlocks('Two things:\n\n1. Run `pm2 restart`.\n2. Check the logs.');
  assert.equal(b.length, 2);
  assert.equal(b[1].text, '1. Run `pm2 restart`.\n2. Check the logs.');
  assert.equal(b[1].translatable, true);
});

test('a horizontal rule carries no prose', () => {
  assert.equal(hasProse('---'), false);
  assert.equal(hasProse('| --- | --- |'), false);
});

test('rejoining translated parts reproduces the shape', () => {
  const src = 'One.\n\n```sh\nls\n```\n\nTwo.';
  const parts = splitBlocks(src).map((b) => (b.translatable ? '译' : b.text));
  assert.equal(joinBlocks(parts), '译\n\n```sh\nls\n```\n\n译');
});

// ── the gates ────────────────────────────────────────────────────────────────

test('auto-translate fires only across a language boundary', () => {
  assert.equal(shouldAutoTranslate('Here is the root cause of the failure.', 'zh'), true);
  assert.equal(shouldAutoTranslate('网关重启把会话杀掉了，已经修好。', 'zh'), false, 'already Chinese');
  assert.equal(shouldAutoTranslate('网关重启把会话杀掉了，已经修好。', 'en'), true);
  assert.equal(shouldAutoTranslate('Here is the root cause of the failure.', 'en'), false);
  assert.equal(shouldAutoTranslate('Done.', 'zh'), false, 'too short to be worth it');
  assert.equal(shouldAutoTranslate('```sh\nls -la\n```', 'zh'), false, 'all code');
});

test('the manual button is offered whenever a block has prose in it', () => {
  assert.equal(canTranslate('Done.'), true, 'the user asking IS the signal');
  assert.equal(canTranslate('```sh\nls -la\n```'), false);
  assert.equal(canTranslate('---'), false);
  assert.equal(canTranslate(''), false);
});

// ── cache keys ───────────────────────────────────────────────────────────────

test('the same block maps to the same key, a different one does not', () => {
  assert.equal(blockKey('hello world', 'zh'), blockKey('hello world', 'zh'));
  assert.notEqual(blockKey('hello world', 'zh'), blockKey('hello worlds', 'zh'));
  assert.notEqual(blockKey('hello world', 'zh'), blockKey('hello world', 'en'));
});

test('the key survives the characters a reply actually contains', () => {
  // Non-BMP and CJK both go through charCodeAt; the point is that it does not
  // throw and stays stable, not that the hash is good.
  const s = '✅ 已部署 — `apps/gateway/src/runtime/claude-sdk.ts:88`\n\n| a | b |';
  assert.equal(blockKey(s, 'zh'), blockKey(s, 'zh'));
});

// ── assembling what is on screen ─────────────────────────────────────────────

import { assemble, completeBlockCount, blockKey as bk, type BlockState } from './translate-text';

/** A lookup backed by a plain object of source-text → translation. */
function lookupFrom(known: Record<string, BlockState>, target: 'zh' | 'en' = 'zh') {
  const byKey = new Map<string, BlockState>();
  for (const [src, val] of Object.entries(known)) byKey.set(bk(src, target), val);
  return (key: string) => byKey.get(key);
}

const REPLY = 'First paragraph.\n\n```sh\nls -la\n```\n\nSecond paragraph.\n\nThird paragraph.';

test('a streaming reply holds back its last block — it is half a sentence', () => {
  const blocks = splitBlocks('One.\n\nTwo.\n\nThr');
  assert.equal(completeBlockCount(blocks, 'One.\n\nTwo.\n\nThr', true), 2);
  assert.equal(completeBlockCount(blocks, 'One.\n\nTwo.\n\nThr', false), 3, 'not streaming — all of it is final');
});

test('text ending in a blank line has no fragment to hold back', () => {
  const src = 'One.\n\nTwo.\n\n';
  const blocks = splitBlocks(src);
  assert.equal(blocks.length, 2);
  assert.equal(completeBlockCount(blocks, src, true), 2);
});

test('nothing known yet — everything is `rest`, nothing is shown', () => {
  const a = assemble(splitBlocks(REPLY), 4, 'zh', lookupFrom({}));
  assert.equal(a.shown, '');
  assert.equal(a.complete, false);
  assert.match(a.rest, /^First paragraph\./);
  assert.deepEqual(a.wanted.map((w) => w.text), ['First paragraph.', 'Second paragraph.', 'Third paragraph.']);
  assert.ok(!a.wanted.some((w) => w.text.includes('ls -la')), 'code is never asked for');
});

test('the first block lands — it and the code block below it are shown', () => {
  const a = assemble(splitBlocks(REPLY), 4, 'zh', lookupFrom({ 'First paragraph.': '第一段。' }));
  assert.equal(a.shown, '第一段。\n\n```sh\nls -la\n```');
  assert.equal(a.rest, 'Second paragraph.\n\nThird paragraph.');
  assert.equal(a.complete, false);
});

test('THE ORDERING RULE — a later block landing first changes nothing on screen', () => {
  const a = assemble(splitBlocks(REPLY), 4, 'zh', lookupFrom({ 'Third paragraph.': '第三段。' }));
  assert.equal(a.shown, '', 'block 3 must not jump the queue');
  assert.doesNotMatch(a.rest, /第三段/, 'and must not appear in the remainder either');
  assert.ok(!a.wanted.some((w) => w.text === 'Third paragraph.'), 'nor be asked for twice');
});

test('everything lands — shown is the whole message and rest is empty', () => {
  const a = assemble(
    splitBlocks(REPLY),
    4,
    'zh',
    lookupFrom({ 'First paragraph.': '第一段。', 'Second paragraph.': '第二段。', 'Third paragraph.': '第三段。' }),
  );
  assert.equal(a.shown, '第一段。\n\n```sh\nls -la\n```\n\n第二段。\n\n第三段。');
  assert.equal(a.rest, '');
  assert.equal(a.complete, true);
  assert.deepEqual(a.wanted, []);
});

test('a refused block falls back to its original instead of stalling the rest', () => {
  const a = assemble(
    splitBlocks(REPLY),
    4,
    'zh',
    lookupFrom({ 'First paragraph.': 'failed', 'Second paragraph.': '第二段。', 'Third paragraph.': '第三段。' }),
  );
  assert.equal(a.shown, 'First paragraph.\n\n```sh\nls -la\n```\n\n第二段。\n\n第三段。');
  assert.equal(a.complete, true);
  assert.ok(!a.wanted.some((w) => w.text === 'First paragraph.'), 'and is not retried');
});

test('a reply that is only code completes without a single request', () => {
  const blocks = splitBlocks('```sh\nls\n```\n\n```sh\npwd\n```');
  const a = assemble(blocks, blocks.length, 'zh', lookupFrom({}));
  assert.deepEqual(a.wanted, []);
  assert.equal(a.complete, true);
  assert.equal(a.shown, '```sh\nls\n```\n\n```sh\npwd\n```');
});

test('mid-stream: the growing block is neither shown nor requested', () => {
  const src = 'First paragraph.\n\nSecond par';
  const blocks = splitBlocks(src);
  const complete = completeBlockCount(blocks, src, true);
  const a = assemble(blocks, complete, 'zh', lookupFrom({ 'First paragraph.': '第一段。' }));
  assert.equal(a.shown, '第一段。');
  assert.equal(a.rest, 'Second par');
  assert.equal(a.complete, false);
  assert.deepEqual(a.wanted, []);
});

test('shown only ever grows as answers arrive', () => {
  const blocks = splitBlocks(REPLY);
  const order = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'];
  const known: Record<string, BlockState> = {};
  let prev = '';
  for (const step of order) {
    known[step] = `<${step}>`;
    const a = assemble(blocks, 4, 'zh', lookupFrom(known));
    assert.ok(a.shown.startsWith(prev), `"${a.shown}" must extend "${prev}" — the typewriter assumes append-only`);
    prev = a.shown;
  }
});
