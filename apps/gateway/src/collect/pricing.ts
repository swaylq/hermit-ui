// Recovering ccusage's per-token prices from ccusage's own output.
//
// The problem: a `ccusage session` row gives ONE cost per model, not a cost per token
// TYPE. To answer "what did this cost with the cache reads taken out" — cache reads
// being ~98% of the tokens and the reason the raw numbers look absurd — we need the
// cache-read price, and ccusage doesn't publish one.
//
// It doesn't have to. Within a model, cost is linear in the four token counts with
// fixed prices, and every collection brings back hundreds of (tokens → cost) rows.
// Four unknowns, hundreds of equations: solve. On the live corpus this reproduces
// ccusage exactly — 1360 rows of claude-opus-4-8 fit input $5.00 / output $25.00 /
// cache-write $6.25 / cache-read $0.50 per Mtok with residual $0.00 (2026-08-03).
//
// Deriving it beats hardcoding it: the table follows ccusage when Anthropic reprices,
// and a model we've never heard of needs no entry. What it must never do is guess — a
// fit that doesn't reproduce the costs it was built from is thrown away, and the
// caller then declines to subtract anything for that model.

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

export type ModelRow = TokenCounts & { modelName: string; cost: number };

/** Dollars per token (NOT per million) for one model. */
export type Prices = { input: number; output: number; cacheWrite: number; cacheRead: number };

/** Rows below this can't pin four unknowns; ill-conditioned fits get thrown out anyway. */
const MIN_ROWS = 8;
/** A fit must reproduce the corpus it came from to within 0.5% of its total cost. */
const MAX_REL_RESIDUAL = 0.005;

/**
 * Least squares over the normal equations (AᵀA x = Aᵀy), Gaussian elimination with
 * partial pivoting. Four columns — small enough that the direct solve is fine and a
 * dependency would be silly.
 */
function solve4(a: number[][], y: number[]): number[] | null {
  const n = 4;
  const ata: number[][] = [];
  for (let i = 0; i < n; i++) {
    ata.push([]);
    for (let j = 0; j < n; j++) ata[i].push(a.reduce((s, r) => s + r[i] * r[j], 0));
  }
  const aty: number[] = [];
  for (let i = 0; i < n; i++) aty.push(a.reduce((s, r, k) => s + r[i] * y[k], 0));

  const m = ata.map((row, i) => [...row, aty[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (!Number.isFinite(m[c][c]) || Math.abs(m[c][c]) < 1e-12) return null; // singular
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = m.map((row, i) => row[n] / row[i]);
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/**
 * Per-model prices, for every model the rows can pin down. A model that's too rare,
 * degenerate (e.g. only ever cache reads), or whose fit doesn't reproduce its own
 * costs is simply absent — callers must handle "no price" rather than get a guess.
 */
export function fitPrices(rows: ModelRow[]): Map<string, Prices> {
  const byModel = new Map<string, ModelRow[]>();
  for (const r of rows) {
    const arr = byModel.get(r.modelName);
    if (arr) arr.push(r);
    else byModel.set(r.modelName, [r]);
  }

  const out = new Map<string, Prices>();
  for (const [model, rs] of byModel) {
    const usable = rs.filter((r) => r.cost > 0);
    if (usable.length < MIN_ROWS) continue;
    // Scale to millions so the columns are the same order of magnitude as the costs;
    // raw token counts make AᵀA badly conditioned.
    const a = usable.map((r) => [
      r.inputTokens / 1e6,
      r.outputTokens / 1e6,
      r.cacheCreationTokens / 1e6,
      r.cacheReadTokens / 1e6,
    ]);
    const y = usable.map((r) => r.cost);
    const x = solve4(a, y);
    if (!x) continue;
    if (x.some((v) => v < 0)) continue; // a negative price means the fit is nonsense

    const totalCost = y.reduce((s, v) => s + v, 0);
    const resid = a.reduce((s, row, k) => s + Math.abs(row.reduce((t, v, i) => t + v * x[i], 0) - y[k]), 0);
    if (totalCost <= 0 || resid / totalCost > MAX_REL_RESIDUAL) continue;

    out.set(model, {
      input: x[0] / 1e6,
      output: x[1] / 1e6,
      cacheWrite: x[2] / 1e6,
      cacheRead: x[3] / 1e6,
    });
  }
  return out;
}

/**
 * What the cache reads in these rows cost. Rows whose model has no usable fit
 * contribute 0 — i.e. nothing is subtracted for them, so an unknown model shows its
 * full cost rather than a made-up reduction.
 */
export function cacheReadCost(rows: ModelRow[], prices: Map<string, Prices>): number {
  let sum = 0;
  for (const r of rows) {
    const p = prices.get(r.modelName);
    if (p) sum += r.cacheReadTokens * p.cacheRead;
  }
  return sum;
}
