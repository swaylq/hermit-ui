// The reveal, tested against the thing it exists to fix: text that arrives in
// lumps must not leave the screen. Every case here is a shape the dashboard
// actually produced — a 250ms push cadence, a placeholder row swapped for the
// real one mid-paragraph, a code fence half-written.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  revealAdvance,
  settleSplit,
  closeOpenFence,
  openFenceAt,
  markReveal,
  adoptReveal,
  resetReveals,
  REVEAL_LAG_MS,
  MIN_CPS,
  TICK_MS,
  ADOPT_MAX_AGE_MS,
} from './stream-reveal';

// ── pace ─────────────────────────────────────────────────────────────────────

test('the reveal never runs past the text it has', () => {
  let shown = 0;
  for (let i = 0; i < 200; i++) shown = revealAdvance(shown, 40, TICK_MS);
  assert.equal(shown, 40);
});

test('a finished reply lands, however few characters are left', () => {
  // Backlog-proportional pacing alone approaches the end asymptotically; the
  // floor is what closes it. Three characters must not take a second.
  let shown = 997;
  let ms = 0;
  while (shown < 1000 && ms < 5_000) { shown = revealAdvance(shown, 1000, TICK_MS); ms += TICK_MS; }
  assert.equal(shown, 1000);
  assert.ok(ms <= 1000 / MIN_CPS * 1000, `took ${ms}ms`);
});

/**
 * Drive the reveal through a stream that arrives in `chunk`-sized lumps every
 * `pushMs`, and report what the reader would have seen.
 */
function simulate({ chunk, pushMs, pushes }: { chunk: number; pushMs: number; pushes: number }) {
  let shown = 0;
  let total = 0;
  let lastGrewAt = 0;
  let worstStall = 0;
  let stall = 0;
  let biggestPaint = 0;
  let firstIdleAt = 0;
  const runMs = pushes * pushMs + 4_000;
  for (let ms = 0; ms <= runMs; ms += TICK_MS) {
    const due = Math.min(pushes, Math.floor(ms / pushMs) + 1) * chunk;
    if (due > total) { total = due; lastGrewAt = ms; }
    const before = Math.floor(shown);
    shown = revealAdvance(shown, total, TICK_MS, ms - lastGrewAt);
    const painted = Math.floor(shown) - before;
    if (painted === 0) {
      // A tick that painted nothing. Only counts while there is text to paint.
      if (before < total) { stall += TICK_MS; worstStall = Math.max(worstStall, stall); }
    } else {
      stall = 0;
      biggestPaint = Math.max(biggestPaint, painted);
    }
    if (!firstIdleAt && Math.floor(shown) >= pushes * chunk) firstIdleAt = ms;
  }
  return { worstStall, biggestPaint, doneAt: firstIdleAt, endedAt: (pushes - 1) * pushMs };
}

test('a 250ms push cadence is not visible in the reveal', () => {
  // The complaint, reproduced: the gateway pushes every 250ms (LIVE_PUSH_MS),
  // and a model writing ~120 chars/s means ~30 characters land at once. Painted
  // straight through, that is four visible lumps a second. Through the reveal no
  // frame may go longer than a tick or two without painting, and no frame may
  // paint a lump — the arriving 30 characters have to come out as ~4 per frame.
  const { worstStall, biggestPaint } = simulate({ chunk: 30, pushMs: 250, pushes: 40 });
  assert.ok(worstStall <= TICK_MS * 2, `stalled ${worstStall}ms mid-stream`);
  assert.ok(biggestPaint <= 8, `painted ${biggestPaint} characters in one frame`);
});

test('a slow writer and a fast writer both stay continuous', () => {
  for (const chunk of [8, 30, 90, 300]) {
    const { worstStall, biggestPaint } = simulate({ chunk, pushMs: 250, pushes: 30 });
    const perFrameShare = (chunk * TICK_MS) / 250;
    assert.ok(worstStall <= TICK_MS * 2, `chunk ${chunk}: stalled ${worstStall}ms`);
    // Whatever the writer's speed, a frame paints about its share of it — never
    // the chunk. (A floor applies: MIN_CPS is ~1 character per frame.)
    assert.ok(
      biggestPaint <= Math.max(2, perFrameShare * 2),
      `chunk ${chunk}: painted ${biggestPaint} in one frame, share is ${perFrameShare.toFixed(1)}`,
    );
  }
});

test('the reveal is close behind the writer, not a paragraph behind it', () => {
  // The lag is deliberate — it is the buffer — but it has to be small enough
  // that the reply reads as live. A stream that stops must be fully on screen
  // within about a second.
  const { doneAt, endedAt } = simulate({ chunk: 30, pushMs: 250, pushes: 40 });
  assert.ok(doneAt - endedAt < 1_100, `finished ${doneAt - endedAt}ms after the last push`);
});

test('a whole reply delivered at once eases in instead of appearing as a slab', () => {
  // Every backend except claude-sdk hands over finished blocks. There is no
  // stream to follow there, so the motion is synthesised — but it still has to
  // be over quickly.
  let shown = 0;
  let ms = 0;
  while (shown < 2000 && ms < 10_000) { shown = revealAdvance(shown, 2000, TICK_MS, ms); ms += TICK_MS; }
  assert.ok(ms > 300, `finished in ${ms}ms — no motion to see`);
  assert.ok(ms < 1_600, `took ${ms}ms to reveal a block that was already here`);
});

test('a stalled frame resumes rather than teleports', () => {
  // A background tab, or a long task, hands the next frame a dt of seconds.
  const shown = revealAdvance(0, 5_000, 30_000);
  assert.ok(shown < 5_000, 'a single frame consumed the whole reply');
  assert.ok(shown > 0, 'a long frame painted nothing');
});

test('text that shrank is not chased backwards', () => {
  assert.equal(revealAdvance(500, 200, TICK_MS), 200);
});

// ── split ────────────────────────────────────────────────────────────────────

test('the split always accounts for every revealed character', () => {
  for (const s of ['', 'a', '一二三\n\n四五', '# h\n\npara\n\n- a\n- b', '```ts\ncode', 'x\n\n']) {
    const { settled, tail } = settleSplit(s);
    assert.equal(settled + tail, s);
  }
});

test('a finished block settles and the one being typed does not', () => {
  const { settled, tail } = settleSplit('结论先说。\n\n这轮改动把打字机');
  assert.equal(settled, '结论先说。\n\n');
  assert.equal(tail, '这轮改动把打字机');
});

test('a half-written code fence stays whole', () => {
  // Settling inside a fence would render as two stacked code boxes.
  const src = 'para\n\n```ts\nconst a = 1;\nconst b = 2;\n';
  const { settled, tail } = settleSplit(src);
  assert.equal(settled, 'para\n\n');
  assert.equal(tail, '```ts\nconst a = 1;\nconst b = 2;\n');
});

test('a closed fence settles like any other block', () => {
  const src = 'para\n\n```ts\nconst a = 1;\n```\n\nnext par';
  assert.equal(settleSplit(src).tail, 'next par');
});

test('a block that outgrows the cap settles by lines instead of re-parsing whole', () => {
  // A long bullet list is one markdown block with no blank line in it, so the
  // blank-line rule alone would re-parse the entire list every frame.
  const list = Array.from({ length: 40 }, (_, i) => `- 第 ${i} 条列表项，用来把这个块撑过上限`).join('\n');
  const { settled, tail } = settleSplit(`前言\n\n${list}`, 200);
  assert.ok(tail.length <= 200, `tail is ${tail.length} chars`);
  assert.ok(settled.endsWith('\n'), 'settled at a line boundary');
  assert.equal(settled + tail, `前言\n\n${list}`);
});

test('a single line longer than the cap is left alone rather than cut mid-sentence', () => {
  const para = '啊'.repeat(400);
  const { settled, tail } = settleSplit(para, 200);
  assert.equal(settled, '');
  assert.equal(tail, para);
});

test('an open fence is closed for rendering, a closed one left alone', () => {
  assert.equal(openFenceAt('```ts\nx'), 0);
  assert.equal(openFenceAt('```ts\nx\n```'), -1);
  assert.equal(closeOpenFence('```ts\nconst a = 1;'), '```ts\nconst a = 1;\n```');
  assert.equal(closeOpenFence('~~~\nx\n'), '~~~\nx\n~~~');
  assert.equal(closeOpenFence('plain text'), 'plain text');
  assert.equal(closeOpenFence('``'), '``', 'two backticks are not a fence yet');
});

// ── carry ────────────────────────────────────────────────────────────────────

test('a row swapped mid-paragraph carries on from where it was', () => {
  // What the gateway actually does: the placeholder row is retracted and the
  // finished record — a different row id, so a fresh component — lands in the
  // same push. Without this the paragraph retypes itself from zero.
  resetReveals();
  markReveal('s1', '这轮改动把打字机效果', 9, 1_000);
  assert.equal(adoptReveal('s1', '这轮改动把打字机效果从一段一段吐改成了字符流', 1_100), 9);
});

test('a genuinely new block types from the beginning', () => {
  resetReveals();
  markReveal('s1', '第一段说的是缓冲区的事情', 12, 1_000);
  assert.equal(adoptReveal('s1', '第二段说的是渲染成本', 1_100), 0);
});

test('a stale mark is not adopted', () => {
  resetReveals();
  markReveal('s1', '这轮改动把打字机效果', 6, 1_000);
  assert.equal(adoptReveal('s1', '这轮改动把打字机效果从头讲起', 1_000 + ADOPT_MAX_AGE_MS + 1), 0);
});

test('a two-character head start is coincidence, not continuity', () => {
  resetReveals();
  markReveal('s1', '好的', 2, 1_000);
  assert.equal(adoptReveal('s1', '好的，这里是另一段完全不同的话', 1_100), 0);
});

test('sessions do not adopt each other s position', () => {
  resetReveals();
  markReveal('s1', '这轮改动把打字机效果', 8, 1_000);
  assert.equal(adoptReveal('s2', '这轮改动把打字机效果从头讲起', 1_100), 0);
});

test('the mark table cannot grow without bound', () => {
  resetReveals();
  for (let i = 0; i < 100; i++) markReveal(`s${i}`, 'x'.repeat(20), 10, 1_000 + i);
  // Nothing to assert on the Map directly (it is private) — but the newest key
  // must still be there, and the oldest must not be adoptable.
  assert.equal(adoptReveal('s99', 'x'.repeat(30), 1_100), 10);
  assert.equal(adoptReveal('s0', 'x'.repeat(30), 1_100), 0);
});

test('the lag constant is the buffer, and is documented in tick multiples', () => {
  // Guard rail: the pace only reads as typing while a tick is a small fraction
  // of the lag. If someone raises TICK_MS past this, the reveal becomes steps.
  assert.ok(TICK_MS * 4 < REVEAL_LAG_MS);
});
