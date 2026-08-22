import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFrame,
  planBottomFrame,
  settledHold,
  EPSILON,
  shouldRecapture,
} from './prepend-anchor-core';

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
  const { correction, offset, raw } = planFrame(hold, { scrollTop: vp.scrollTop, anchorTop: vp.anchorTop });
  const before = vp.scrollTop;
  if (correction !== 0) vp.user(correction);
  // What the viewport really did — clamped, and possibly quantised.
  hold.offset = settledHold(offset, raw, vp.scrollTop - before);
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
  const { correction, gap, raw } = planBottomFrame(hold, {
    scrollTop: vp.scrollTop,
    scrollHeight: vp.scrollHeight,
    clientHeight: vp.clientHeight,
  });
  const before = vp.scrollTop;
  if (correction !== 0) vp.user(correction);
  hold.gap = settledHold(gap, raw, vp.scrollTop - before);
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


// --- what a write COSTS, not just what it computes ---------------------------
//
// Every one of these is about the same defect: a correction the viewport cannot
// carry out, re-issued on the next frame because nothing recorded that it did
// not land. On a desktop that is invisible. On iOS each write is
// `setContentOffset`, which ends the reader's momentum scroll — so a correction
// that repeats for the whole settle window is a list that will not glide for
// one and a half seconds after every "load earlier". Measured on the deployed
// dashboard before this: 93 writes in a 1.7s hold, one per frame, while a
// smooth scroll of 5,000px managed 2,785 of them and then stopped dead.

// A viewport whose scrollTop is an integer, which every browser's is.
function quantised(opts: { height: number; client: number; top: number; anchorTop: number }) {
  const vp = viewport(opts);
  const user = vp.user.bind(vp);
  vp.user = (px: number) => {
    const before = vp.scrollTop;
    user(px);
    const landed = Math.trunc(vp.scrollTop) - Math.trunc(before);
    vp.anchorTop += vp.scrollTop - before - landed; // the sub-pixel part never happened
    vp.scrollTop = Math.trunc(before) + landed;
  };
  return vp;
}

test('a whole settle window does not turn into one write per frame', () => {
  // The measured defect, reproduced without a browser: content settles by a
  // fraction of a pixel, the correction is issued, `scrollTop` quantises it away
  // to nothing, and the next frame computes the very same correction. 1.5s of
  // holding at 60fps is 90 frames — and 90 momentum-ending writes.
  const vp = quantised({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.grow(0.7); // a font swap; nowhere near a pixel of reading position
  let writes = 0;
  for (let i = 0; i < 90; i++) if (frame(vp, hold) !== 0) writes++;
  assert.ok(writes <= 1, `held for 90 frames and wrote scrollTop ${writes} times`);
});

test('growth that IS worth correcting still converges in one write', () => {
  const vp = quantised({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.grow(1.4); // a code block gaining a scrollbar
  let writes = 0;
  for (let i = 0; i < 30; i++) if (frame(vp, hold) !== 0) writes++;
  assert.equal(writes, 1, 'exactly one write, not one per frame');
  assert.equal(vp.scrollTop, 2001);
});

test('a correction the viewport is clamped out of is not re-issued every frame', () => {
  // At the very top: there is nowhere to scroll up to, so a negative correction
  // cannot be carried out at all.
  const vp = viewport({ height: 5000, client: 700, top: 0, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 0 };
  vp.grow(-400); // content above the anchor SHRANK (a run capsule collapsing)
  const writes = [frame(vp, hold), frame(vp, hold), frame(vp, hold), frame(vp, hold), frame(vp, hold)];
  assert.equal(writes.filter((c) => c !== 0).length, 1, 'one attempt, then it lets go');
  assert.equal(vp.scrollTop, 0);
  assert.equal(hold.offset, vp.anchorTop, 'the hold moved to where the row actually is');
});

test('the same, for the tail hold', () => {
  const vp = bottomViewport({ height: 3000, client: 600, top: 2400 });
  const hold = { gap: 0, lastTop: 2400 };
  // Content shrinks below the reader while they sit at the very bottom: the
  // correction wants to scroll further down than the content allows.
  vp.scrollHeight -= 400;
  vp.scrollTop = 2400; // browser has not re-clamped yet
  const writes = [bottomFrame(vp, hold), bottomFrame(vp, hold), bottomFrame(vp, hold), bottomFrame(vp, hold)];
  assert.equal(writes.filter((c) => c !== 0).length, 1);
});

test('sub-pixel growth is below the write threshold entirely', () => {
  const vp = viewport({ height: 5000, client: 700, top: 2000, anchorTop: 120 });
  const hold = { offset: 120, lastTop: 2000 };
  vp.grow(0.4);
  assert.equal(frame(vp, hold), 0, 'never worth ending a fling for');
  assert.ok(EPSILON >= 1, 'the threshold is a whole pixel, because scrollTop is quantised');
});

// --- shouldRecapture: never re-measure on top of a hold that is still working --

test('with no hold at all, a pull must measure one', () => {
  assert.equal(shouldRecapture(null, 1000), true);
  assert.equal(shouldRecapture(undefined, 1000), true);
});

test('a hold whose settle window has passed is re-measured', () => {
  assert.equal(shouldRecapture({ until: 1000 }, 1000), true);
  assert.equal(shouldRecapture({ until: 1000 }, 1500), true);
});

test('a hold that is still live is kept, not re-measured', () => {
  // The warm-cache case: the second pull fires while the first page is still
  // landing. Re-measuring here records the displacement as the target.
  assert.equal(shouldRecapture({ until: 2000 }, 1000), false);
});

test('five back-to-back pulls share one hold', () => {
  // The top-up prefill fires up to five times, and on a warm cache all five land
  // within a few ms of each other. Exactly one of them may measure.
  let held: { until: number } | null = null;
  const measured: number[] = [];
  for (let i = 0; i < 5; i++) {
    const now = 1000 + i * 3;
    if (shouldRecapture(held, now)) {
      measured.push(now);
      held = { until: now + 1500 };
    } else {
      held = { until: now + 1500 }; // rearm pushes the window out, same hold
    }
  }
  assert.deepEqual(measured, [1000]);
});

test('a pull long after the last one measures again', () => {
  // The reader stopped, read for a while, then scrolled up once more. That is a
  // new reading position and it must be measured.
  const held: { until: number } = { until: 2500 };
  assert.equal(shouldRecapture(held, 1000), false);
  assert.equal(shouldRecapture(held, 9000), true);
});
