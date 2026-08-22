import test from 'node:test';
import assert from 'node:assert/strict';
import { widthBucket } from './db';

// A measured height is only true at the width it was measured at, so the width
// is part of the key. Bucketing keeps a scrollbar appearing, or a window dragged
// by a pixel, from orphaning everything measured a moment earlier.

test('nearby widths share a bucket', () => {
  assert.equal(widthBucket(358), widthBucket(359));
  assert.equal(widthBucket(358), widthBucket(361));
});

test('widths far enough apart do not', () => {
  // A phone and a laptop must never read each other's heights back.
  assert.notEqual(widthBucket(358), widthBucket(720));
});

test('a bucket is stable — bucketing twice changes nothing', () => {
  for (const w of [0, 1, 7, 8, 359, 390, 768, 1440]) {
    assert.equal(widthBucket(widthBucket(w)), widthBucket(w), `unstable at ${w}`);
  }
});

test('nonsense widths do not produce a negative key', () => {
  // clientWidth is 0 on a detached or hidden pane, which happens on mount.
  assert.equal(widthBucket(0), 0);
  assert.ok(widthBucket(-50) >= 0);
});
