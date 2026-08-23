import test from 'node:test';
import assert from 'node:assert/strict';
import { planBottomFrame, settledHold, type BottomHold } from './prepend-anchor-core';
import { acceptableCompensation, contentHeight } from './scroll-stability-core';

// The open-a-session flicker, reproduced as arithmetic against a model of what
// the engine actually does.
//
// Live numbers, WebKit 390×844, a session short enough that opening it pulls a
// page of history in: the tail anchor was holding gap 0 at scrollTop 697 when
// the commit briefly made the list shorter than one screen and the browser
// clamped scrollTop to 0. From there the corrections went
// −697, +1529, −1516, +1638, −684, −841, +1483 on consecutive painted frames.
//
// Two engine facts drive the model below, both measured:
//   · a downward translate on the content layer adds its own size to the
//     scroller's scrollable overflow;
//   · WebKit recomputes that overflow only when the transform is added or
//     removed, or when a real layout runs — a value change leaves it latched.
// So `scrollHeight` is not merely inflated, it is inflated by a number from an
// earlier frame. The layer's own offsetHeight is layout, so it is neither.

const CLIENT = 652;
const TRUE_CONTENT = 1349;

/**
 * The list is momentarily shorter than one screen on the frame the prepend
 * commits — that is the transient the browser answers by clamping scrollTop to
 * 0, and what the anchor then mistakes for the reader scrolling up.
 */
function laidOutContent(frame: number): number {
  // Frame 4 is a second collapse: the list is rebuilt short again as a later
  // chunk commits, which is what the live logs show happening repeatedly.
  return frame === 0 || frame === 4 ? CLIENT : TRUE_CONTENT;
}

type Engine = { latched: number; transformOn: boolean; laidOut: number };

/** What the scroller reports, with WebKit's latching. */
function observedScrollHeight(engine: Engine, laidOut: number, deviation: number): number {
  const on = Math.abs(deviation) >= 0.01;
  const relayout = laidOut !== engine.laidOut;
  if (on !== engine.transformOn || relayout) {
    engine.latched = Math.max(CLIENT, laidOut + Math.max(0, -deviation));
    engine.transformOn = on;
    engine.laidOut = laidOut;
  }
  return engine.latched;
}

type Run = { corrections: number[]; deviations: number[] };

function run(frames: number, opts: { honestHeight: boolean; clamp: boolean; guard?: boolean }): Run {
  // The frame the browser clamped: physically at the top, tail hold intact.
  // Nothing here writes scrollTop — that is the point of the transform — so the
  // physical offset stays where the clamp left it until a later settlement.
  const physical = 0;
  let deviation = 0;
  let compensated = 0;
  const engine: Engine = { latched: CLIENT, transformOn: false, laidOut: laidOutContent(0) };
  const hold: BottomHold = { gap: 0, lastTop: 697 };
  const out: Run = { corrections: [], deviations: [] };

  for (let i = 0; i < frames; i += 1) {
    const laidOut = laidOutContent(i);
    const observed = observedScrollHeight(engine, laidOut, deviation);
    const honest = contentHeight({ layerHeight: laidOut, scrollHeight: observed, clientHeight: CLIENT });
    const measurable = !opts.guard || honest > CLIENT;
    const plan = planBottomFrame(hold, {
      scrollTop: physical + deviation,
      userScrollTop: physical + deviation - compensated,
      scrollHeight: opts.honestHeight ? honest : observed,
      clientHeight: CLIENT,
    });
    const wanted = measurable ? plan.correction : 0;
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

test('the tail anchor flies when it measures against its own transform', () => {
  const before = run(8, { honestHeight: false, clamp: false });
  // Same shape as the live log (−697, +1529, −1516, +1638 …), smaller only
  // because this model holds the content still between the collapses while the
  // real one was committing rows every frame.
  assert.ok(Math.min(...before.deviations) <= -600, JSON.stringify(before));
  const swing = Math.max(...before.deviations.map((d, i) => (
    i === 0 ? 0 : Math.abs(d - before.deviations[i - 1])
  )));
  assert.ok(swing >= 1300, `expected a visible flight between frames, got ${swing}px`);
});

test('the honest height alone is not enough — the clamp is what stops the flight', () => {
  const halfFixed = run(8, { honestHeight: true, clamp: false });
  // The anchor still paints the full −697 of a browser clamp it mistook for
  // reader input, i.e. 697px of blank above the first message.
  assert.ok(Math.min(...halfFixed.deviations) <= -600, JSON.stringify(halfFixed.deviations));
});

test('the clamp keeps a mis-measured correction off the screen, but not the collapse', () => {
  const clamped = run(8, { honestHeight: true, clamp: true });
  // No blank above the first message any more.
  assert.ok(Math.min(...clamped.deviations) >= 0, JSON.stringify(clamped.deviations));
  // But frame 4's collapse still convinces the anchor the end moved to zero, so
  // it gives back its whole correction and takes it again on the recovery — the
  // ±900-1,150px yank still visible on a live open after the first two fixes.
  const swing = Math.max(...clamped.deviations.map((d, i) => (
    i === 0 ? 0 : Math.abs(d - clamped.deviations[i - 1])
  )));
  assert.ok(swing >= 600, `expected the collapse to move the reader, got ${swing}px`);
});

test('a frame where the list is shorter than the viewport paints nothing', () => {
  const shipped = run(8, { honestHeight: true, clamp: true, guard: true });
  assert.equal(shipped.corrections[4], 0, 'the collapsed frame must issue nothing');
  assert.ok(Math.min(...shipped.deviations) >= 0, JSON.stringify(shipped.deviations));
  // One movement — the correction that reaches the tail — and then stillness,
  // across both collapses.
  const moves = shipped.deviations.map((d, i) => (i === 0 ? d : Math.abs(d - shipped.deviations[i - 1])));
  assert.equal(moves.filter((m) => m > 1).length, 1, JSON.stringify(shipped));
  // And the hold is not left believing the reader scrolled: it ends on the end.
  assert.equal(shipped.deviations[shipped.deviations.length - 1], TRUE_CONTENT - CLIENT);
});

test('a real correction is applied in full when there is room to spare', () => {
  // The reader is mid-list and history genuinely grew above them, with the
  // target well inside the range rather than on its edge.
  const hold: BottomHold = { gap: 900, lastTop: 400 };
  // Distinct inputs, so the measurement actually has to choose the layer: the
  // scroller is carrying 500px of an earlier transform.
  const honest = contentHeight({ layerHeight: 3000, scrollHeight: 3500, clientHeight: CLIENT });
  assert.equal(honest, 3000);
  const plan = planBottomFrame(hold, {
    scrollTop: 400,
    userScrollTop: 400,
    scrollHeight: honest,
    clientHeight: CLIENT,
  });
  assert.equal(plan.correction, 3000 - 400 - CLIENT - 900);
  assert.ok(400 + plan.correction < 3000 - CLIENT, 'the target must not sit on the boundary');
  assert.equal(acceptableCompensation({
    scrollTop: 400, deviation: 0, delta: plan.correction, minTop: 0, maxTop: 3000 - CLIENT,
  }), plan.correction);
});
