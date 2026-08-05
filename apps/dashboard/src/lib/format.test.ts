// fmtBytes is the compact formatter for TOKEN counts (context sizes in ctx-bar, daily
// totals in usage-sparkline). The B tier exists because the usage chart hit ~10.4B
// cache-read tokens over 14 days and printed it as `10641.71M`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes } from './format';

describe('fmtBytes', () => {
  it('leaves small counts alone', () => {
    assert.equal(fmtBytes(0), '0');
    assert.equal(fmtBytes(999), '999');
  });

  it('switches unit at each thousand-fold, not before', () => {
    assert.equal(fmtBytes(1_000), '1.0k');
    assert.equal(fmtBytes(999_999), '1000.0k');
    assert.equal(fmtBytes(1_000_000), '1.00M');
    assert.equal(fmtBytes(999_999_999), '1000.00M');
    assert.equal(fmtBytes(1_000_000_000), '1.00B');
  });

  it('keeps a real 14-day cache-read total readable', () => {
    assert.equal(fmtBytes(10_385_169_740), '10.39B');
  });

  it('has a dash for the absent value', () => {
    assert.equal(fmtBytes(null), '-');
    assert.equal(fmtBytes(undefined), '-');
  });
});
