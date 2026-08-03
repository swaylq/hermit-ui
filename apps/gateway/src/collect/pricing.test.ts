// The price fit. Cases are built from a KNOWN price vector, so the assertion is
// "does it recover what we put in" rather than "does it match today's live data".
// The one real-world anchor is the Opus tier ccusage was observed using on
// 2026-08-03: $5 / $25 / $6.25 / $0.50 per Mtok.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitPrices, cacheReadCost, type ModelRow } from './pricing';

const OPUS = { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.5 / 1e6 };

function row(model: string, i: number, o: number, cw: number, cr: number, p = OPUS): ModelRow {
  return {
    modelName: model,
    inputTokens: i,
    outputTokens: o,
    cacheCreationTokens: cw,
    cacheReadTokens: cr,
    cost: i * p.input + o * p.output + cw * p.cacheWrite + cr * p.cacheRead,
  };
}

// Shapes a real session mix produces: cache reads dwarf everything, and the ratios
// between the four counters move around from session to session.
function corpus(model: string, n: number, p = OPUS): ModelRow[] {
  const out: ModelRow[] = [];
  for (let k = 1; k <= n; k++) {
    out.push(row(model, 1000 * k, 5000 * (k % 7) + 900, 30_000 * (k % 5) + 1200, 900_000 * k + 40_000 * (k % 3), p));
  }
  return out;
}

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

describe('fitPrices', () => {
  it('recovers the price vector it was generated from', () => {
    const p = fitPrices(corpus('claude-opus-4-8', 40)).get('claude-opus-4-8');
    assert.ok(p, 'expected a fit');
    near(p.input * 1e6, 5, 1e-6);
    near(p.output * 1e6, 25, 1e-6);
    near(p.cacheWrite * 1e6, 6.25, 1e-6);
    near(p.cacheRead * 1e6, 0.5, 1e-6);
  });

  it('fits each model separately', () => {
    const sonnet = { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.3 / 1e6 };
    const prices = fitPrices([...corpus('opus', 30), ...corpus('sonnet', 30, sonnet)]);
    near(prices.get('opus')!.cacheRead * 1e6, 0.5, 1e-6);
    near(prices.get('sonnet')!.cacheRead * 1e6, 0.3, 1e-6);
  });

  it('declines a model with too few rows to pin four unknowns', () => {
    assert.equal(fitPrices(corpus('rare', 3)).has('rare'), false);
  });

  it('declines a model whose costs do not fit ONE price vector', () => {
    // Same model, repriced halfway through — a blended fit would be a fiction.
    const half = { input: 2.5 / 1e6, output: 12.5 / 1e6, cacheWrite: 3.125 / 1e6, cacheRead: 0.25 / 1e6 };
    const mixed = [...corpus('shifting', 20), ...corpus('shifting', 20, half)];
    assert.equal(fitPrices(mixed).has('shifting'), false);
  });

  it('declines rows that would imply a negative price', () => {
    const rows = corpus('weird', 20).map((r, i) => (i % 2 ? { ...r, cost: r.cost * 0.2 } : r));
    const p = fitPrices(rows).get('weird');
    if (p) for (const v of Object.values(p)) assert.ok(v >= 0, 'no negative price may survive');
  });

  it('ignores zero-cost rows rather than letting them drag the fit', () => {
    const rows = [...corpus('opus', 20), row('opus', 0, 0, 0, 0)];
    near(fitPrices(rows).get('opus')!.cacheRead * 1e6, 0.5, 1e-6);
  });
});

describe('cacheReadCost', () => {
  const prices = fitPrices(corpus('claude-opus-4-8', 40));

  it('prices exactly the cache reads, nothing else', () => {
    const rows = [row('claude-opus-4-8', 1000, 2000, 3000, 10_000_000)];
    near(cacheReadCost(rows, prices), 10_000_000 * 0.5e-6);
  });

  it('subtracts nothing for a model it has no price for', () => {
    const rows = [row('some-new-model', 1000, 2000, 3000, 10_000_000)];
    assert.equal(cacheReadCost(rows, prices), 0);
  });

  it('never exceeds the rows own cost on a realistic mix', () => {
    const rows = corpus('claude-opus-4-8', 25);
    const total = rows.reduce((s, r) => s + r.cost, 0);
    const cr = cacheReadCost(rows, prices);
    assert.ok(cr > 0 && cr < total, `${cr} should sit inside (0, ${total})`);
  });
});
