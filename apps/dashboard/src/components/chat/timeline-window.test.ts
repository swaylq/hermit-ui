import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planWindow,
  fullWindow,
  heightsFor,
  estimateFrom,
  liftFromSettled,
  fitProseHeights,
  type WindowInput,
} from './timeline-window';

const uniform = (n: number, h = 100): number[] => new Array(n).fill(h);
const plan = (o: Partial<WindowInput> & { heights: number[] }) =>
  planWindow({ scrollTop: 0, viewportHeight: 900, overscan: 0, threshold: 0, ...o });

test('a short timeline is rendered whole, spacers and all', () => {
  const p = planWindow({ heights: uniform(50), scrollTop: 5000, viewportHeight: 900, overscan: 0, threshold: 400 });
  assert.deepEqual(p, { start: 0, end: 50, padTop: 0, padBottom: 0 });
});

test('the window covers the viewport', () => {
  const p = plan({ heights: uniform(100), scrollTop: 2000 });
  // rows 20..28 span 2000..2900
  assert.equal(p.start, 20);
  assert.equal(p.end, 29);
  assert.equal(p.padTop, 2000);
  assert.equal(p.padBottom, (100 - 29) * 100);
});

test('spacers preserve the total height exactly', () => {
  const heights = uniform(500, 73);
  const total = heights.reduce((a, b) => a + b, 0);
  for (const scrollTop of [0, 1000, 9999, 30000, total - 900]) {
    const p = plan({ heights, scrollTop, overscan: 1800 });
    const rendered = heights.slice(p.start, p.end).reduce((a, b) => a + b, 0);
    assert.equal(p.padTop + rendered + p.padBottom, total, `at scrollTop ${scrollTop}`);
  }
});

test('overscan keeps extra rows mounted on both sides', () => {
  const tight = plan({ heights: uniform(200), scrollTop: 5000, overscan: 0 });
  const loose = plan({ heights: uniform(200), scrollTop: 5000, overscan: 1000 });
  assert.ok(loose.start < tight.start, 'more above');
  assert.ok(loose.end > tight.end, 'more below');
  assert.equal(loose.start, 40);
  assert.equal(loose.end, 69);
});

test('at the very top nothing is skipped above', () => {
  const p = plan({ heights: uniform(300), scrollTop: 0, overscan: 600 });
  assert.equal(p.start, 0);
  assert.equal(p.padTop, 0);
});

test('at the very bottom nothing is skipped below', () => {
  const heights = uniform(300);
  const total = heights.reduce((a, b) => a + b, 0);
  const p = plan({ heights, scrollTop: total - 900, overscan: 600 });
  assert.equal(p.end, 300);
  assert.equal(p.padBottom, 0);
});

test('ragged heights are handled by position, not by index', () => {
  const heights = [1000, 40, 40, 2000, 40, 40, 40];
  const p = plan({ heights, scrollTop: 1100, viewportHeight: 100 });
  // 1100 lands inside item 3 (which spans 1080..3080)
  assert.equal(p.start, 3);
  assert.equal(p.padTop, 1080);
});

test('a scroll position past the end still renders something', () => {
  const heights = uniform(500);
  const p = plan({ heights, scrollTop: 999_999 });
  assert.ok(p.end > p.start, 'window is not empty');
  assert.equal(p.end, 500);
  const rendered = heights.slice(p.start, p.end).reduce((a, b) => a + b, 0);
  assert.equal(p.padTop + rendered + p.padBottom, 50_000);
});

test('an empty timeline is not a special case', () => {
  assert.deepEqual(plan({ heights: [] }), { start: 0, end: 0, padTop: 0, padBottom: 0 });
});

test('fullWindow is what the threshold shortcut returns', () => {
  assert.deepEqual(fullWindow(7), { start: 0, end: 7, padTop: 0, padBottom: 0 });
});

test('the estimate is the mean of what has actually been seen', () => {
  assert.equal(estimateFrom(new Map(), 80), 80);
  assert.equal(estimateFrom(new Map([['a', 100], ['b', 200]]), 80), 150);
});

test('measured heights win, everything else gets the estimate', () => {
  const measured = new Map([['b', 300], ['c', 100]]);
  assert.deepEqual(heightsFor(['a', 'b', 'c', 'd'], measured, 80), [200, 300, 100, 200]);
});

// "Load earlier" prepends a page, shifting every index. Heights keyed by the
// row itself survive that; heights keyed by position would describe the wrong
// messages and the reading position would jump by the error.
test('a prepend does not invalidate what was measured', () => {
  const measured = new Map([['m5', 500], ['m6', 600]]);
  const before = heightsFor(['m5', 'm6'], measured, 80);
  const after = heightsFor(['new1', 'new2', 'm5', 'm6'], measured, 80);
  assert.deepEqual(before, [500, 600]);
  assert.deepEqual(after.slice(2), [500, 600]);
  assert.deepEqual(after.slice(0, 2), [550, 550]);
});

// The window must not lurch when a guess is replaced by a measurement: the
// caller keeps the reading position by comparing padTop before and after, so
// padTop has to be derived only from the heights it was given.
test('padTop is exactly the sum of the skipped heights', () => {
  const measured = new Map<string, number>();
  const keys = Array.from({ length: 600 }, (_, i) => `k${i}`);
  for (let i = 0; i < 30; i++) measured.set(`k${i}`, 50);
  const heights = heightsFor(keys, measured, 80);
  const p = plan({ heights, scrollTop: 3000, overscan: 0 });
  const expected = heights.slice(0, p.start).reduce((a, b) => a + b, 0);
  assert.equal(p.padTop, expected);
});

// --- liftFromSettled: undoing a row that settled above the reader ------------
//
// Coordinates are the browser's: `bottom` is the row's bottom edge after the
// change, `viewportTop` the top edge of the scroller. Smaller is higher up.

test('a row that grew entirely above the reader is undone in full', () => {
  assert.equal(liftFromSettled([{ was: 100, now: 160, bottom: 40 }], 100), 60);
});

test('a row that SHRANK above the reader is undone the other way', () => {
  // The translation case: 840px of English replaced by 580px of Chinese, well
  // above the fold. Bottom ends at -340, so before it shrank it was at -80 —
  // above the edge both before and after, and every removed pixel was offscreen.
  assert.equal(liftFromSettled([{ was: 840, now: 580, bottom: -340 }], 100), -260);
});

test('a shrink that pulled the row up past the reader is left alone', () => {
  // Ends above the edge (bottom 20) but started below it (bottom 280): some of
  // the pixels that went away were on screen, so undoing the whole change would
  // move text the reader was actually looking at.
  assert.equal(liftFromSettled([{ was: 840, now: 580, bottom: 20 }], 100), 0);
});

test('a row that grew across the top edge still counts in full', () => {
  // Bottom is now 130, below the edge at 100 — but before it grew it was at 30,
  // fully above. Testing the post-change edge would silently drop the biggest
  // pushes, which are exactly the ones the reader notices.
  assert.equal(liftFromSettled([{ was: 100, now: 200, bottom: 130 }], 100), 100);
});

test('a row the reader is looking at is left alone', () => {
  // Straddles the top edge before and after: part of the change is above the
  // reader's eye and part below, and there is no single right correction.
  assert.equal(liftFromSettled([{ was: 100, now: 160, bottom: 200 }], 100), 0);
});

test('a row below the viewport is left alone', () => {
  assert.equal(liftFromSettled([{ was: 100, now: 400, bottom: 900 }], 100), 0);
});

test('several rows settling in one frame are summed', () => {
  const lift = liftFromSettled(
    [
      { was: 200, now: 120, bottom: 10 },   // shrank above  -80
      { was: 100, now: 150, bottom: 60 },   // grew above    +50
      { was: 100, now: 300, bottom: 500 },  // below the edge  0
    ],
    100,
  );
  assert.equal(lift, -30);
});

test('a row that did not actually change contributes nothing', () => {
  assert.equal(liftFromSettled([{ was: 100, now: 100, bottom: 10 }], 100), 0);
});

test('nothing settled, nothing to undo', () => {
  assert.equal(liftFromSettled([], 100), 0);
});

// --- fitProseHeights / heightsFor: predicting a row from its prose -----------
//
// The model is `real = a * prose + b`. `b` is everything a row has whatever it
// says (bubble padding, avatar, timestamp, the gaps between markdown blocks);
// `a` picks up the fact that prose was laid out at the ROW's width and the
// bubble is narrower.

const linear = (n: number, a: number, b: number) =>
  Array.from({ length: n }, (_, i) => ({ prose: 20 + i * 17, real: a * (20 + i * 17) + b }));

test('a clean relationship is recovered exactly', () => {
  const fit = fitProseHeights(linear(20, 1.2, 46));
  assert.ok(fit);
  assert.ok(Math.abs(fit.a - 1.2) < 1e-6, `slope ${fit.a}`);
  assert.ok(Math.abs(fit.b - 46) < 1e-6, `intercept ${fit.b}`);
});

test('too few measured rows is not a fit', () => {
  assert.equal(fitProseHeights(linear(7, 1.2, 46)), null);
});

test('rows with no prose never enter the fit', () => {
  // A screenshot row is 400px tall with 0px of prose. Left in, it would drag the
  // intercept up for every text row in the conversation.
  const pairs = [...linear(20, 1.2, 46), ...Array.from({ length: 10 }, () => ({ prose: 0, real: 400 }))];
  const fit = fitProseHeights(pairs);
  assert.ok(fit);
  assert.ok(Math.abs(fit.a - 1.2) < 1e-6);
  assert.ok(Math.abs(fit.b - 46) < 1e-6);
});

test('a handful of rows carrying a code block do not tilt the line', () => {
  // Prose plus something unpredictable: same text, hundreds of px taller. The
  // second pass drops them and the ordinary row is described correctly again.
  const pairs = [...linear(24, 1.2, 46)];
  pairs[3] = { prose: pairs[3].prose, real: pairs[3].real + 700 };
  pairs[11] = { prose: pairs[11].prose, real: pairs[11].real + 900 };
  const fit = fitProseHeights(pairs);
  assert.ok(fit);
  assert.ok(Math.abs(fit.a - 1.2) < 0.05, `slope ${fit.a}`);
  assert.ok(Math.abs(fit.b - 46) < 12, `intercept ${fit.b}`);
});

test('every sample the same length gives no slope, and says so', () => {
  const flat = Array.from({ length: 20 }, () => ({ prose: 100, real: 166 }));
  assert.equal(fitProseHeights(flat), null);
});

test('an implausible slope is refused rather than believed', () => {
  const wild = Array.from({ length: 20 }, (_, i) => ({ prose: 20 + i, real: (20 + i) * 40 }));
  assert.equal(fitProseHeights(wild), null);
});

test('a fitted prediction beats the running mean on a realistic spread', () => {
  // This is the whole point, so measure it rather than assert the machinery ran.
  // Row heights in a real conversation are anything from a one-line "好的。" to a
  // page of markdown; the mean gives all of them the same number.
  const rows = Array.from({ length: 60 }, (_, i) => {
    const prose = [18, 18, 36, 54, 120, 240, 480, 72][i % 8] + (i % 5) * 6;
    return { key: `k${i}`, prose, real: 1.2 * prose + 46 };
  });
  // Half of them have been on screen; the other half have to be guessed.
  const seen = rows.slice(0, 30);
  const unseen = rows.slice(30);
  const measured = new Map(seen.map((r) => [r.key, r.real]));
  const prose = new Map(rows.map((r) => [r.key, r.prose]));
  const fit = fitProseHeights(seen.map((r) => ({ prose: r.prose, real: r.real })));
  assert.ok(fit);

  const keys = unseen.map((r) => r.key);
  const withFit = heightsFor(keys, measured, 90, prose, fit);
  const withMean = heightsFor(keys, measured, 90);
  const err = (got: number[]) =>
    got.reduce((a, h, i) => a + Math.abs(h - unseen[i].real), 0) / got.length;

  const meanErr = err(withMean);
  const fitErr = err(withFit);
  assert.ok(meanErr > 80, `the mean should be badly wrong here, was ${meanErr}`);
  assert.ok(fitErr < 1, `the fit should be nearly exact here, was ${fitErr}`);
});

test('without a fit, heightsFor is exactly what it always was', () => {
  const measured = new Map([['a', 100], ['b', 300]]);
  assert.deepEqual(heightsFor(['a', 'b', 'c'], measured, 90), [100, 300, 200]);
  assert.deepEqual(heightsFor(['a', 'b', 'c'], measured, 90, new Map([['c', 50]]), null), [100, 300, 200]);
});

test('a measurement always beats a prediction', () => {
  const measured = new Map([['a', 137]]);
  const fit = { a: 1.2, b: 46, samples: 20 };
  assert.deepEqual(heightsFor(['a'], measured, 90, new Map([['a', 1000]]), fit), [137]);
});

test('a row with no prose falls back to the mean even with a fit in hand', () => {
  // 0 means "asked, and this row is a picture" — not "predicted to be 0px tall".
  const measured = new Map([['a', 100], ['b', 300]]);
  const fit = { a: 1.2, b: 46, samples: 20 };
  assert.deepEqual(heightsFor(['c'], measured, 90, new Map([['c', 0]]), fit), [200]);
});

test('a prediction is never shorter than a line', () => {
  const measured = new Map([['a', 100], ['b', 300]]);
  const fit = { a: 1.2, b: -400, samples: 20 };
  assert.deepEqual(heightsFor(['c'], measured, 90, new Map([['c', 10]]), fit), [24]);
});
