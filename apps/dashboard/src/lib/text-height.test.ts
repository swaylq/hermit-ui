import test from 'node:test';
import assert from 'node:assert/strict';
import { stripInline, proseHeight, __setTextHeightLib, textHeightReady } from './text-height';

// --- stripInline: source characters that are not laid-out characters ---------

test('emphasis marks are not laid out', () => {
  assert.equal(stripInline('the **root cause** is'), 'the root cause is');
  assert.equal(stripInline('an _emphasis_ and __strong__'), 'an emphasis and strong');
});

test('a link lays out its label, not its target', () => {
  assert.equal(
    stripInline('see [the platform bug ledger](https://github.com/chenglou/pretext/blob/main/PLATFORM_BUGS.md)'),
    'see the platform bug ledger',
  );
});

test('an image lays out nothing — its height is not text', () => {
  assert.equal(stripInline('before ![a screenshot](/files/a.png) after'), 'before  after');
});

test('an image inside a link does not leave the label behind', () => {
  // The image rule has to run first, or `![alt](src)` degrades to `!alt`.
  assert.equal(stripInline('![alt](/a.png)'), '');
});

test('code spans lay out their contents', () => {
  assert.equal(stripInline('call `getBoundingClientRect()` here'), 'call getBoundingClientRect() here');
});

test('block-level marks are left alone', () => {
  // `#`, `>` and `- ` change the block's geometry, not the width of its text;
  // that part is the fit's job, not this one's.
  assert.equal(stripInline('## Heading'), '## Heading');
  assert.equal(stripInline('> quoted'), '> quoted');
  assert.equal(stripInline('- an item'), '- an item');
});

test('plain prose survives untouched, in either language', () => {
  const zh = '根因是虚拟化窗口对没见过的行只能估高。';
  assert.equal(stripInline(zh), zh);
  assert.equal(stripInline('nothing to strip here'), 'nothing to strip here');
});

// --- proseHeight: the pretext seam ------------------------------------------

const fakeLib = (lines: number) => ({
  prepare: (text: string) => text,
  layout: () => ({ height: lines * 20, lineCount: lines }),
});

test('with no library loaded, there is no prediction — not a zero height', () => {
  __setTextHeightLib(null);
  assert.equal(textHeightReady(), false);
  // blocks:0 is what tells the caller to fall back rather than believe a 0.
  assert.deepEqual(proseHeight('some prose', { font: '16px X', lineHeight: 20, width: 300 }), {
    height: 0,
    blocks: 0,
  });
});

test('every prose block contributes its own laid-out lines', () => {
  __setTextHeightLib(fakeLib(2));
  const r = proseHeight('first paragraph\n\nsecond paragraph', { font: '16px X', lineHeight: 20, width: 300 });
  assert.equal(r.blocks, 2);
  assert.equal(r.height, 80); // 2 blocks x 2 lines x 20px
  __setTextHeightLib(null);
});

test('a row that is only a code fence gets no prediction', () => {
  // Its height depends on a scrollbar that may or may not appear, and on
  // highlighting that has not run yet. Better to say nothing than to guess.
  __setTextHeightLib(fakeLib(3));
  const r = proseHeight('```ts\nconst a = 1;\n```', { font: '16px X', lineHeight: 20, width: 300 });
  assert.equal(r.blocks, 0);
  __setTextHeightLib(null);
});

test('a library that throws takes down one row, not the session', () => {
  __setTextHeightLib({
    prepare: () => {
      throw new Error('canvas said no');
    },
    layout: () => ({ height: 0, lineCount: 0 }),
  });
  assert.deepEqual(proseHeight('some prose', { font: '16px X', lineHeight: 20, width: 300 }), {
    height: 0,
    blocks: 0,
  });
  __setTextHeightLib(null);
});

test('a degenerate width or line height is refused rather than divided by', () => {
  __setTextHeightLib(fakeLib(2));
  assert.equal(proseHeight('prose', { font: '16px X', lineHeight: 20, width: 0 }).blocks, 0);
  assert.equal(proseHeight('prose', { font: '16px X', lineHeight: 0, width: 300 }).blocks, 0);
  __setTextHeightLib(null);
});

test('an empty block still occupies one line, as the browser gives it', () => {
  __setTextHeightLib({ prepare: (t: string) => t, layout: () => ({ height: 0, lineCount: 0 }) });
  const r = proseHeight('prose', { font: '16px X', lineHeight: 20, width: 300 });
  assert.equal(r.height, 20);
  __setTextHeightLib(null);
});
