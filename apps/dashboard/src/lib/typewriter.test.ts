// The reveal animation. Every case here is something a user would notice going
// wrong: text that never catches up, a one-word correction that backspaces
// through a whole paragraph, or a frame that overshoots what the ASR actually
// said.

import test from 'node:test';
import assert from 'node:assert/strict';
import { typeFrame, stepFor, commonPrefixLen, MAX_REWIND } from './typewriter';

/** Run frames until settled, and report how many it took. */
function settle(from: string, to: string, cap = 500): { frames: number; out: string } {
  let cur = from;
  for (let i = 0; i < cap; i++) {
    const next = typeFrame(cur, to);
    if (next === cur) return { frames: i, out: cur };
    cur = next;
  }
  return { frames: cap, out: cur };
}

test('typing forward reveals one character at a time', () => {
  assert.equal(typeFrame('帮我', '帮我把这', 1), '帮我把');
  assert.equal(typeFrame('帮我把', '帮我把这', 1), '帮我把这');
});

test('a frame never shows a character the target does not have', () => {
  let cur = '';
  const target = '帮我把 rathole 的隧道重启一下。';
  for (let i = 0; i < 100 && cur !== target; i++) {
    cur = typeFrame(cur, target);
    assert.ok(target.startsWith(cur), `frame "${cur}" is not a prefix of the target`);
  }
  assert.equal(cur, target);
});

test('a short tail correction drops the wrong tail in one frame, then retypes', () => {
  // Straight from a real trace: the ASR changing its mind about the last few
  // characters it emitted. Half-deleted states like "…PADDY重重" read as a
  // rendering bug, so the wrong tail goes all at once.
  const from = '帮我把这apan上';
  const to = '帮我把JAPAN DEV上的PADDY穿';
  const first = typeFrame(from, to, 1);
  assert.equal(first, '帮我把', 'the wrong tail is gone in a single frame');
  assert.equal(settle(from, to).out, to);
});

test('the polish landing one sentence back still animates as a correction', () => {
  // Also from a real trace: sentence one gets corrected while sentence two has
  // only just started. Close enough to the end to be worth watching change.
  const from = '帮我把JAPAN DEV上的PADDY重启一下。然后';
  const to = '帮我把JAPAN DEV上的Caddy重启一下。然后';
  assert.notEqual(typeFrame(from, to), to, 'did not snap');
  assert.equal(settle(from, to).out, to);
});

test('a wholesale ASR re-reading snaps rather than crawling backwards', () => {
  const from = '帮我把JUPANDAV上的PADDY';
  const to = '帮我把JAPAN DEV上的PADDY重启一下。';
  assert.equal(typeFrame(from, to), to);
});

test('a correction upstream snaps instead of backspacing through the rest', () => {
  // The polish fixing sentence one while sentence two is already typed out.
  const from = '帮我把japandev上的pady重启一下。然后检查一下证书';
  const to = '帮我把 japan-dev 上的 caddy 重启一下。然后检查一下证书';
  assert.equal(typeFrame(from, to), to, 'landed in a single frame');
});

test('the snap threshold is about the distance from the END, not the diff size', () => {
  const from = 'abcdefghij' + 'x'.repeat(MAX_REWIND + 1);
  const to = 'abcdefghij' + 'y'.repeat(MAX_REWIND + 1);
  assert.equal(typeFrame(from, to), to);
  const near = 'abcdefghij' + 'x'.repeat(3);
  const nearTo = 'abcdefghij' + 'y'.repeat(3);
  assert.notEqual(typeFrame(near, nearTo), nearTo, 'a near-tail change animates');
});

test('a big backlog catches up faster than one character a tick', () => {
  const target = 'x'.repeat(240);
  assert.ok(stepFor('', target) > 1);
  // 240 chars must not take 240 ticks (that would be ~7s of visible lag).
  assert.ok(settle('', target).frames < 60, 'catches up within about a second');
});

test('an ordinary ASR lump still reveals one character per tick', () => {
  assert.equal(stepFor('帮我把这', '帮我把这apan上'), 1);
});

test('settled text produces no further frames', () => {
  assert.equal(typeFrame('同样的字', '同样的字'), '同样的字');
  assert.equal(settle('同样的字', '同样的字').frames, 0);
});

test('shrinking to empty (a cancelled run) settles at empty', () => {
  assert.equal(settle('已经说了很多字的一段话', '').out, '');
});

test('commonPrefixLen handles the degenerate cases', () => {
  assert.equal(commonPrefixLen('', 'abc'), 0);
  assert.equal(commonPrefixLen('abc', 'abc'), 3);
  assert.equal(commonPrefixLen('abc', 'abd'), 2);
});
