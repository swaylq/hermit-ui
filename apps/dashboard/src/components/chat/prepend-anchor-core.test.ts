import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFrame,
  planBottomFrame,
  settledHold,
  EPSILON,
  shouldRecapture,
  planTailFrame,
  chooseTailHold,
  tailHoldLost,
  forcedByClamp,
  type BottomHold,
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

function bottomFrame(vp: ReturnType<typeof bottomViewport>, hold: BottomHold) {
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
  const hold: BottomHold = { gap: 0, lastTop: 0, peak: 0 };
  vp.prepend(2200);
  assert.equal(bottomFrame(vp, hold), 2200);
  assert.equal(vp.scrollTop, 2200); // scrolled down by exactly what arrived
  assert.equal(vp.scrollHeight - vp.scrollTop - vp.clientHeight, 0); // still on the bottom
});

test('a user scroll during a bottom hold is never undone', () => {
  const vp = bottomViewport({ height: 3000, client: 600, top: 2400 });
  const hold: BottomHold = { gap: 0, lastTop: 2400, peak: 0 };
  vp.user(-120); // one wheel notch up, off the bottom
  assert.equal(bottomFrame(vp, hold), 0);
  assert.equal(vp.scrollTop, 2280); // the notch stands
  assert.equal(hold.gap, 120); // the gap tracks the reader instead
});

test('prepend and a user scroll in the same frame: only the prepend is corrected', () => {
  const vp = bottomViewport({ height: 3000, client: 600, top: 2400 });
  const hold: BottomHold = { gap: 0, lastTop: 2400, peak: 0 };
  vp.prepend(2200);
  vp.user(-120);
  assert.equal(bottomFrame(vp, hold), 2200);
  assert.equal(vp.scrollTop, 2400 - 120 + 2200);
});

test('a transform compensation is not mistaken for bottom-anchor user input', () => {
  const hold: BottomHold = { gap: 0, lastTop: 1000 , peak: 0 };
  // Content grew 400px and the shared stability controller moved the natural
  // coordinate by the same 400px, while its reader-only coordinate stayed put.
  const compensated = planBottomFrame(hold, {
    scrollTop: 1400,
    userScrollTop: 1000,
    scrollHeight: 2000,
    clientHeight: 600,
  });
  assert.equal(compensated.correction, 0);
  assert.equal(compensated.gap, 0);

  const userMoved = planBottomFrame(hold, {
    scrollTop: 1300,
    userScrollTop: 900,
    scrollHeight: 2000,
    clientHeight: 600,
  });
  assert.equal(userMoved.correction, 0);
  assert.equal(userMoved.gap, 100);
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
  const hold: BottomHold = { gap: 0, lastTop: 2400, peak: 0 };
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

// ── the tail-hold decision, exercised through planTailFrame ──────────────────
//
// These go through the WHOLE decision on purpose. Two earlier versions of this
// rule shipped with a fully green suite because every test addressed a helper
// and none addressed the decision the hook actually makes — the round-2 critic
// reverted both rules in the hook and all 730 tests stayed green.
//
// Slack and geometry below are the real ones: BOTTOM_SLACK=60, a 723px viewport.

const SLACK = 60;

test('mount: the browser clamping the tail does NOT become the hold target', () => {
  // Real frame from a 420-row session. capture() at 1273; next frame the window
  // re-rendered, the list got shorter, and the browser clamped to the new max
  // (1787 - 723 = 1064) to the pixel.
  const hold: BottomHold = { gap: 0, lastTop: 1273, peak: 1787 };
  const p = planTailFrame(hold, {
    readerTop: 1064, scrollTop: 1064, scrollHeight: 1787, clientHeight: 723,
    maxTop: 1064, slack: SLACK,
  });
  assert.equal(p.clamped, true, 'landing exactly on the new max is a clamp');
  assert.equal(p.gap, 0, 'so the target is still the tail, not 209px above it');
  assert.equal(p.abandon, false, 'and the hold keeps working');
});

test('streaming: a reader scrolling away from a live turn is BELIEVED', () => {
  // The round-2 rule ("did the content re-lay out?") was true on every frame
  // here, so it undid the reader's scroll frame after frame — measured at 40Hz,
  // the reader asked for 1560px and the view went 570px the other way.
  // Growth RAISES maxTop, so this can never look like a clamp.
  const hold: BottomHold = { gap: 0, lastTop: 1082, peak: 2000 };
  const p = planTailFrame(hold, {
    readerTop: 822,            // the reader went up 260px …
    scrollTop: 822,
    scrollHeight: 1817,        // … while the streaming tail grew 6px
    clientHeight: 723,
    maxTop: 1094,              // 1817 - 723; note prevTop 1082 < this
    slack: SLACK,
  });
  assert.equal(p.clamped, false, 'growth cannot masquerade as a clamp');
  assert.equal(p.gap, 260, 'the reader moved 260px and the hold books it');
  assert.equal(p.abandon, true, '260 > 60, so the hold lets go and they escape');
});

test('streaming: the escape hatch is not shut by the attribution rule', () => {
  // The interlock the round-2 critic found: an un-adopted delta leaves gap at 0,
  // so tailHoldLost never fires and the reader has no way out. Walk several
  // streaming frames and assert the hold releases rather than holding forever.
  let hold: BottomHold = { gap: 0, lastTop: 2000, peak: 3000 };
  let height = 2723;
  let top = 2000;
  let released = false;
  for (let frame = 0; frame < 6; frame++) {
    height += 6;                       // the reply keeps arriving
    top -= 260;                        // and the reader keeps scrolling up
    const p = planTailFrame(hold, {
      readerTop: top, scrollTop: top, scrollHeight: height, clientHeight: 723,
      maxTop: height - 723, slack: SLACK,
    });
    if (p.abandon) { released = true; break; }
    hold = { ...hold, gap: p.gap, lastTop: top };
  }
  assert.equal(released, true, 'the reader must be able to leave a streaming tail');
});

test('a nudge INSIDE the slack keeps the hold', () => {
  // Geometry has to be self-consistent: content 1787 in a 723 viewport puts the
  // maximum at 1064, so a reader AT the end was at 1064 — not at 1273, which is
  // a position that scroller cannot hold. (The first version of this test said
  // 1273 and only passed because the old yes/no clamp test ignored the number.)
  const hold: BottomHold = { gap: 0, lastTop: 1064, peak: 1787 };
  const p = planTailFrame(hold, {
    readerTop: 1024, scrollTop: 1024, scrollHeight: 1787, clientHeight: 723,
    maxTop: 1064, slack: SLACK,
  });
  assert.equal(p.clamped, false, 'nothing shrank; this was all the reader');
  assert.equal(p.gap, 40);
  assert.equal(p.abandon, false, '40px is still "at the end"');
});

test('every input device is treated the same, because none is recognised', () => {
  // PageUp and a scrollbar drag raise no reader-intent signal at all; that is
  // what round 1 got wrong. Distance and clamping do not care.
  for (const [device, top] of [['PageUp', 454], ['scrollbar drag', 1428], ['wheel', 1000]] as const) {
    const p = planTailFrame({ gap: 0, lastTop: 2144, peak: 2867 }, {
      readerTop: top, scrollTop: top, scrollHeight: 2867, clientHeight: 723,
      maxTop: 2144, slack: SLACK,
    });
    assert.equal(p.clamped, false, `${device} is not a clamp`);
    assert.equal(p.abandon, true, `${device} must be able to leave the tail`);
  }
});

test('forcedByClamp measures HOW MUCH the browser had to move us', () => {
  // The old position is 209px past the end that now exists.
  assert.equal(forcedByClamp({ lastTop: 1273, maxTopReader: 1064 }), -209);
  // The old position still exists — nothing was forced.
  assert.equal(forcedByClamp({ lastTop: 1000, maxTopReader: 1064 }), 0);
  // Growth (the streaming case) raises the end, so never anything forced.
  assert.equal(forcedByClamp({ lastTop: 2000, maxTopReader: 2600 }), 0);
});

test('a frame where the list shrank AND the reader scrolled splits the two', () => {
  // Round 3 booked the WHOLE 330px as the reader's, because the yes/no pixel
  // test ("did we land exactly on the maximum?") fails the moment a person also
  // moved. The reader was then thrown out of a hold they never left.
  const hold: BottomHold = { gap: 0, lastTop: 1273, peak: 2000 };
  const p = planTailFrame(hold, {
    readerTop: 943,            // 300px of clamp + 30px of reader
    scrollTop: 943,            // no compensation painted this frame
    scrollHeight: 1696, clientHeight: 723,
    maxTop: 973,               // the list lost 300px
    slack: 60,
  });
  assert.equal(p.clamped, true, 'the browser did force part of it');
  assert.equal(p.gap, 30, 'but only the 30px the reader actually did is kept');
  assert.equal(p.abandon, false, '30px is inside the slack — they did not leave');
});

test('the clamp check survives a hold that has already compensated', () => {
  // The other half of the round-3 bug: `lastTop` is a READER coordinate and the
  // maximum is a LOGICAL one, and inside one hold they were measured 1,080px
  // apart. Comparing them directly made the check structurally dead after the
  // first correction. planTailFrame now converts using the compensation that is
  // painted right now, which is logical minus reader.
  const hold: BottomHold = { gap: 0, lastTop: 1064, peak: 2867 };
  const p = planTailFrame(hold, {
    readerTop: 1064,           // reader coordinate …
    scrollTop: 2144,           // … logical is 1080 higher: that much is a transform
    scrollHeight: 2867, clientHeight: 723,
    maxTop: 2144,              // logical maximum — equals logical top, i.e. AT the end
    slack: 60,
  });
  assert.equal(p.gap, 0, 'at the end is at the end, whatever is painted as transform');
  assert.equal(p.abandon, false);
});

test('tailHoldLost is exact about the boundary', () => {
  assert.equal(tailHoldLost(0, 60), false);
  assert.equal(tailHoldLost(60, 60), false, 'the slack itself is still the tail');
  assert.equal(tailHoldLost(61, 60), true);
  assert.equal(tailHoldLost(-120, 60), false, 'rubber-banding past the end is not leaving');
});

// ── which hold gets taken (the wiring two regressions hid in) ────────────────
test('ordinary case: the geometry says we are at the end', () => {
  assert.equal(chooseTailHold({ contentBottomGap: 0, clientHeight: 723, followingTail: false, slack: 60 }), true);
  assert.equal(chooseTailHold({ contentBottomGap: 59, clientHeight: 723, followingTail: false, slack: 60 }), true);
});

test('cold cache: a noisy mid-assembly reading does not cost a follower the tail', () => {
  // 109px is over the slack, but the page says they are still following and the
  // list is only part-rendered. Round 4: taking a ROW hold here left 4 cold opens
  // in 6 permanently 270px short, with the pin still on so no "↓ latest" either.
  assert.equal(chooseTailHold({ contentBottomGap: 109, clientHeight: 723, followingTail: true, slack: 60 }), true);
  // Not following → the reading is taken at face value.
  assert.equal(chooseTailHold({ contentBottomGap: 109, clientHeight: 723, followingTail: false, slack: 60 }), false);
});

test('a stale-true pin cannot drag a history reader to the bottom', () => {
  // One viewport is the ceiling on the second door: someone 800px up is reading,
  // whatever a stale pin claims.
  assert.equal(chooseTailHold({ contentBottomGap: 800, clientHeight: 723, followingTail: true, slack: 60 }), false);
  assert.equal(chooseTailHold({ contentBottomGap: 722, clientHeight: 723, followingTail: true, slack: 60 }), true);
});
