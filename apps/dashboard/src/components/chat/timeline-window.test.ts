import test from 'node:test';
import assert from 'node:assert/strict';
import { planWindow, fullWindow, heightsFor, estimateFrom, type WindowInput } from './timeline-window';

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
