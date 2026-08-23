import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTailFrame,
  planBottomFrame,
  settledHold,
  type BottomHold,
} from './prepend-anchor-core';
import { acceptableCompensation, contentHeight } from './scroll-stability-core';

// The open-a-session flicker, replayed from the numbers the anchor was actually
// handed on a live open (WebKit 390×844, session 隐藏已归档会话, warm cache).
// `window.__prependAnchorLog`, in order:
//
//   raw=-697 applied=0     H=652    <- whole list inside one viewport
//   raw=832  applied=832   H=1484
//   raw=-819 applied=-819  H=665    <- half-rendered
//   raw=954  applied=954   H=1619
//   raw=-841 applied=-841  H=778    <- half-rendered
//   raw=912  applied=912   H=1690
//
// Every one of those corrections was painted, so the tail was thrown ±800-950px
// three times in the first 450ms of opening the conversation. The heights are
// the input; the point of the test is which of them the anchor should believe.

const CLIENT = 652;
const HEIGHTS = [652, 1484, 665, 1619, 778, 1690, 1690, 1690, 1690, 1690];
const TAIL = 1690 - CLIENT;

function laidOutContent(frame: number): number {
  return HEIGHTS[Math.min(frame, HEIGHTS.length - 1)];
}

type Engine = { latched: number; transformOn: boolean; laidOut: number };

/**
 * What the scroller reports. A downward translate adds its own size to the
 * scrollable overflow, and WebKit recomputes that only when the transform is
 * added or removed, or when a real layout runs — a value change leaves it
 * latched. Both measured on the live dashboard.
 */
function observedScrollHeight(engine: Engine, laidOut: number, deviation: number): number {
  const on = Math.abs(deviation) >= 0.01;
  if (on !== engine.transformOn || laidOut !== engine.laidOut) {
    engine.latched = Math.max(CLIENT, laidOut + Math.max(0, -deviation));
    engine.transformOn = on;
    engine.laidOut = laidOut;
  }
  return engine.latched;
}

type Run = { corrections: number[]; deviations: number[] };
type Options = { honestHeight: boolean; clamp: boolean; classify?: boolean };

function run(frames: number, opts: Options): Run {
  // The frame the browser clamped: physically at the top, tail hold intact.
  // Nothing here writes scrollTop — that is the point of the transform — so the
  // physical offset stays where the clamp left it until a later settlement.
  const physical = 0;
  let deviation = 0;
  let compensated = 0;
  const engine: Engine = { latched: CLIENT, transformOn: false, laidOut: laidOutContent(0) };
  const hold: BottomHold = { gap: 0, lastTop: 697, peak: 1349 };
  const out: Run = { corrections: [], deviations: [] };

  for (let i = 0; i < frames; i += 1) {
    const laidOut = laidOutContent(i);
    const observed = observedScrollHeight(engine, laidOut, deviation);
    const honest = contentHeight({ layerHeight: laidOut, scrollHeight: observed, clientHeight: CLIENT });
    const height = opts.honestHeight ? honest : observed;
    const kind = opts.classify
      ? classifyTailFrame({ contentHeight: height, clientHeight: CLIENT, peak: hold.peak })
      : 'measure';
    if (kind === 'ignore') {
      out.corrections.push(0);
      out.deviations.push(deviation);
      continue;
    }
    if (kind === 'measure') hold.peak = Math.max(hold.peak, height);
    const plan = planBottomFrame(hold, {
      scrollTop: physical + deviation,
      userScrollTop: physical + deviation - compensated,
      scrollHeight: height,
      clientHeight: CLIENT,
    });
    const wanted = kind === 'measure' ? plan.correction : 0;
    const accepted = opts.clamp
      ? acceptableCompensation({
        scrollTop: physical,
        deviation,
        delta: wanted,
        minTop: 0,
        maxTop: Math.max(0, honest - CLIENT),
      })
      : wanted;
    deviation += accepted;
    compensated += accepted;
    hold.gap = settledHold(plan.gap, plan.raw, accepted);
    hold.lastTop = physical + deviation - compensated;
    out.corrections.push(wanted);
    out.deviations.push(deviation);
  }
  return out;
}

function biggestStep(deviations: number[]): number {
  return Math.max(...deviations.map((d, i) => (i === 0 ? Math.abs(d) : Math.abs(d - deviations[i - 1]))));
}


test('the tail anchor flies when it measures against its own transform', () => {
  const before = run(10, { honestHeight: false, clamp: false });
  // Blank painted above the first message, and a flight between frames — the
  // same shape as the live log, which reached ±1,638px.
  assert.ok(Math.min(...before.deviations) <= -600, JSON.stringify(before));
  assert.ok(biggestStep(before.deviations) >= 1300, JSON.stringify(before.deviations));
});

test('the honest height alone is not enough — the clamp is what stops the flight', () => {
  const halfFixed = run(10, { honestHeight: true, clamp: false });
  // The anchor still paints the full −697 of a browser clamp it mistook for
  // reader input, i.e. 697px of blank above the first message.
  assert.ok(Math.min(...halfFixed.deviations) <= -600, JSON.stringify(halfFixed.deviations));
});

test('the clamp keeps the blank off the screen, but not the half-rendered frames', () => {
  const clamped = run(10, { honestHeight: true, clamp: true });
  assert.ok(Math.min(...clamped.deviations) >= 0, JSON.stringify(clamped.deviations));
  // The 665px and 778px readings still pull the tail back, then the tall ones
  // put it forward again: the ±800-950px that survived the first two fixes.
  const backwards = clamped.corrections.filter((c) => c < -100);
  assert.ok(backwards.length >= 2, JSON.stringify(clamped.corrections));
});

test('a half-rendered frame is not a measurement of the conversation', () => {
  const shipped = run(10, { honestHeight: true, clamp: true, classify: true });
  // Nothing moves backwards, ever: the reader is carried to the tail in steps
  // and never pulled off it.
  const backwards = shipped.corrections.filter((c) => c < 0);
  assert.deepEqual(backwards, [], JSON.stringify(shipped));
  for (let i = 1; i < shipped.deviations.length; i += 1) {
    assert.ok(shipped.deviations[i] >= shipped.deviations[i - 1], JSON.stringify(shipped.deviations));
  }
  // And it still arrives exactly on the tail, which is what the flicker cost.
  assert.equal(shipped.deviations[shipped.deviations.length - 1], TAIL);
  // The first correction is the big one — it restores the tail the browser
  // clamped away — and everything after it is a small step toward the growing
  // end, not a yank. Measured deviations: 0, 832, 832, 967, 967, 1038 …
  const steps = shipped.deviations.slice(1).map((d, i) => Math.abs(d - shipped.deviations[i]));
  assert.ok(Math.max(...steps.slice(1)) <= 200, JSON.stringify(steps));
});

test('classification: only a real shrink of more than a viewport is disbelieved', () => {
  const clientHeight = 652;
  // Ordinary geometry.
  assert.equal(classifyTailFrame({ contentHeight: 1690, clientHeight, peak: 1690 }), 'measure');
  // A row settling shorter, or a run folding: believable, and corrected.
  assert.equal(classifyTailFrame({ contentHeight: 1200, clientHeight, peak: 1690 }), 'measure');
  // The measured half-renders.
  assert.equal(classifyTailFrame({ contentHeight: 665, clientHeight, peak: 1484 }), 'ignore');
  assert.equal(classifyTailFrame({ contentHeight: 778, clientHeight, peak: 1619 }), 'ignore');
  // The whole list inside one viewport: the browser clamped for the same
  // reason, so this frame is planned (to cancel it) but never painted.
  assert.equal(classifyTailFrame({ contentHeight: 652, clientHeight, peak: 1349 }), 'absorb');
  // A conversation that genuinely is one screen tall is the same case.
  assert.equal(classifyTailFrame({ contentHeight: 400, clientHeight, peak: 400 }), 'absorb');
});
