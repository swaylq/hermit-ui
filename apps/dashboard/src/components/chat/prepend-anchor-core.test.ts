import test from 'node:test';
import assert from 'node:assert/strict';
import { planFrame, planBottomFrame, EPSILON } from './prepend-anchor-core';

// A stand-in for the scroll viewport: content of a known height, a reading
// position, and one row we're holding steady. `grow` prepends height ABOVE the
// row (what "load earlier" does); `user` is the hand on the trackpad.
function viewport(opts: { height: number; client: number; top: number; anchorTop: number }) {
  const vp = {
    scrollHeight: opts.height,
    clientHeight: opts.client,
    scrollTop: opts.top,
    // Where the anchor row's top edge sits relative to the top of the viewport.
    anchorTop: opts.anchorTop,
    grow(px: number) {
      this.scrollHeight += px;
      this.anchorTop += px; // content above it got taller, so it moved down
    },
    user(px: number) {
      const next = Math.max(0, Math.min(this.scrollTop + px, this.scrollHeight - this.clientHeight));
      this.anchorTop -= next - this.scrollTop;
      this.scrollTop = next;
    },
  };
  return vp;
}

// One frame of the rAF pump, exactly as the hook runs it.
function frame(vp: ReturnType<typeof viewport>, hold: { offset: number; lastTop: number }) {
  const { correction, offset } = planFrame(hold, { scrollTop: vp.scrollTop, anchorTop: vp.anchorTop });
  hold.offset = offset;
  if (correction !== 0) vp.user(correction);
  hold.lastTop = vp.scrollTop; // the REAL post-write value, so clamping can't be misread
  return correction;
}

test('a still viewport is left alone', () => {
  const vp = viewport({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  assert.equal(frame(vp, hold), 0);
  assert.equal(vp.scrollTop, 2000);
});

test('content growing above the anchor is absorbed', () => {
  const vp = viewport({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.grow(400);
  assert.equal(frame(vp, hold), 400);
  assert.equal(vp.scrollTop, 2400); // pushed down by exactly the growth
  assert.equal(vp.anchorTop, 120); // the row the user is reading has not moved
  assert.equal(hold.offset, 120);
});

// The bug this file exists for. The anchor used to correct by the anchor row's
// TOTAL displacement, which includes the distance the user just scrolled — so
// every wheel notch was undone one frame later. Measured on the live dashboard:
// 4800px of wheel input moved the view 59px.
test('a user scroll is never undone', () => {
  const vp = viewport({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.user(-120); // one wheel notch upward
  assert.equal(frame(vp, hold), 0);
  assert.equal(vp.scrollTop, 1880); // the notch stands
  assert.equal(hold.offset, 240); // the anchor moved WITH them instead
});

test('a user scroll downward is never undone either', () => {
  const vp = viewport({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.user(240);
  assert.equal(frame(vp, hold), 0);
  assert.equal(vp.scrollTop, 2240);
});

test('growth and a user scroll in the same frame: only the growth is corrected', () => {
  const vp = viewport({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.grow(400);
  vp.user(-120);
  assert.equal(frame(vp, hold), 400);
  assert.equal(vp.scrollTop, 2000 - 120 + 400); // the notch survives, the growth is absorbed
});

test('sub-pixel drift is ignored rather than fought', () => {
  const vp = viewport({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.grow(EPSILON / 2);
  assert.equal(frame(vp, hold), 0);
  assert.equal(vp.scrollTop, 2000);
});

// The whole gesture, which is what "scrolling up feels wrong" actually is: a
// fling that lands a page of history mid-flight and keeps going.
test('a fling through a prepend keeps every pixel the user asked for', () => {
  const vp = viewport({ height: 5000, client: 700, top: 900, anchorTop: 40 });
  const hold = { offset: 40, lastTop: 900 };
  let corrected = 0;
  for (let i = 0; i < 20; i++) {
    if (i === 5) vp.grow(2200); // "load earlier" lands one page of history
    vp.user(-120);
    corrected += frame(vp, hold);
  }
  assert.equal(corrected, 2200); // the prepend, and nothing else, was corrected
  // 900 start − 20 notches of 120 + the 2200 absorbed = where the user should be.
  assert.equal(vp.scrollTop, 900 - 20 * 120 + 2200);
});

test('clamping at the top is not mistaken for a user scroll', () => {
  const vp = viewport({ height: 5000, client: 700, top: 30, anchorTop: 0 });
  const hold = { offset: 0, lastTop: 30 };
  vp.user(-200); // clamps at 0; only 30px of it was real
  assert.equal(vp.scrollTop, 0);
  frame(vp, hold);
  assert.equal(frame(vp, hold), 0); // and the next frame is quiet, not chasing the clamp
  assert.equal(vp.scrollTop, 0);
});

// ── the bottom hold ──────────────────────────────────────────────────────────
// Same rule, mirrored: a reader pinned to the end keeps the tail steady while
// history is prepended above it.

// A stand-in for a viewport that is being held at its bottom edge.
function bottomViewport(opts: { height: number; client: number; top: number }) {
  const vp = {
    scrollHeight: opts.height,
    clientHeight: opts.client,
    scrollTop: opts.top,
    prepend(px: number) {
      this.scrollHeight += px; // history landed above; scrollTop is untouched
    },
    user(px: number) {
      const next = Math.max(0, Math.min(this.scrollTop + px, this.scrollHeight - this.clientHeight));
      this.scrollTop = next;
    },
  };
  return vp;
}

function bottomFrame(vp: ReturnType<typeof bottomViewport>, hold: { gap: number; lastTop: number }) {
  const { correction, gap } = planBottomFrame(hold, {
    scrollTop: vp.scrollTop,
    scrollHeight: vp.scrollHeight,
    clientHeight: vp.clientHeight,
  });
  hold.gap = gap;
  if (correction !== 0) vp.user(correction);
  hold.lastTop = vp.scrollTop;
  return correction;
}

test('a bottom-pinned reader stays on the tail when history is prepended', () => {
  const vp = bottomViewport({ height: 600, client: 600, top: 0 });
  const hold = { gap: 0, lastTop: 0 };
  vp.prepend(2200);
  assert.equal(bottomFrame(vp, hold), 2200);
  assert.equal(vp.scrollTop, 2200); // scrolled down by exactly what arrived
  assert.equal(vp.scrollHeight - vp.scrollTop - vp.clientHeight, 0); // still on the bottom
});

test('a user scroll during a bottom hold is never undone', () => {
  const vp = bottomViewport({ height: 3000, client: 600, top: 2400 });
  const hold = { gap: 0, lastTop: 2400 };
  vp.user(-120); // one wheel notch up, off the bottom
  assert.equal(bottomFrame(vp, hold), 0);
  assert.equal(vp.scrollTop, 2280); // the notch stands
  assert.equal(hold.gap, 120); // the gap tracks the reader instead
});

test('prepend and a user scroll in the same frame: only the prepend is corrected', () => {
  const vp = bottomViewport({ height: 3000, client: 600, top: 2400 });
  const hold = { gap: 0, lastTop: 2400 };
  vp.prepend(2200);
  vp.user(-120);
  assert.equal(bottomFrame(vp, hold), 2200);
  assert.equal(vp.scrollTop, 2400 - 120 + 2200);
});
