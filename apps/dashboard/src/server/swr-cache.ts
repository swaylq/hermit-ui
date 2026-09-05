// A small cache for values that are expensive to compute and cheap to keep a
// little stale: resolved credentials, here.
//
// Two rules, both paid for by the machine-key cache this replaces:
//
//  - One computation per key at a time. Concurrent misses share the promise
//    instead of each running their own bcrypt. Measured on the VPS (cost 12):
//    one compare is 320ms of blocked event loop, twenty at once are 6.4s — and
//    twenty is what four gateways' pollers produce in the seconds after every
//    5-minute expiry, so the whole dashboard stalled on that schedule.
//  - A stale value is served, not discarded. Past `freshMs` the caller gets the
//    old value at once and a refresh runs behind it. The entry only disappears
//    when a refresh answers null (revoked) or someone invalidates it; a refresh
//    that throws keeps the stale value and is retried after `retryMs`.
//
// A key that resolves to null is remembered for `negativeMs`, so a client that
// keeps polling with a revoked key costs one compare per window, not one per
// request.

export interface SwrCacheOptions<V> {
  /** Age past which a hit still returns but a refresh is started. */
  freshMs: number;
  /** How long a null answer is remembered. Default 10s. */
  negativeMs?: number;
  /** How long after a failed refresh before the next call tries again. Default 5s. */
  retryMs?: number;
  resolve: (key: string) => Promise<V | null>;
  /** Injectable clock, for driving the cache without waiting. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  at: number;
  refreshing: boolean;
  failedAt: number;
}

const NEGATIVE_MAX = 10_000;

export class SwrCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V | null>>();
  private readonly negative = new Map<string, number>();
  private readonly freshMs: number;
  private readonly negativeMs: number;
  private readonly retryMs: number;
  private readonly resolve: (key: string) => Promise<V | null>;
  private readonly now: () => number;

  constructor(opts: SwrCacheOptions<V>) {
    this.freshMs = opts.freshMs;
    this.negativeMs = opts.negativeMs ?? 10_000;
    this.retryMs = opts.retryMs ?? 5_000;
    this.resolve = opts.resolve;
    this.now = opts.now ?? Date.now;
  }

  async get(key: string): Promise<V | null> {
    const now = this.now();
    const e = this.entries.get(key);
    if (e) {
      if (now - e.at > this.freshMs && !e.refreshing && now - e.failedAt >= this.retryMs) this.refresh(key, e);
      return e.value;
    }
    const neg = this.negative.get(key);
    if (neg !== undefined) {
      if (now - neg < this.negativeMs) return null;
      this.negative.delete(key);
    }
    const value = await this.once(key);
    if (value === null) {
      this.remember(key);
      return null;
    }
    this.entries.set(key, { value, at: this.now(), refreshing: false, failedAt: 0 });
    return value;
  }

  /** Drop every entry the predicate matches; the next call re-resolves. */
  deleteWhere(pred: (value: V) => boolean): void {
    for (const [k, e] of this.entries) {
      if (pred(e.value)) this.entries.delete(k);
    }
  }

  private once(key: string): Promise<V | null> {
    let p = this.inflight.get(key);
    if (!p) {
      p = this.resolve(key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private refresh(key: string, e: Entry<V>): void {
    e.refreshing = true;
    void this.once(key).then(
      (value) => {
        // Invalidated while the refresh ran: whoever replaced it has newer facts.
        if (this.entries.get(key) !== e) return;
        if (value === null) {
          this.entries.delete(key);
          this.remember(key);
        } else {
          this.entries.set(key, { value, at: this.now(), refreshing: false, failedAt: 0 });
        }
      },
      () => {
        e.refreshing = false;
        e.failedAt = this.now();
      },
    );
  }

  private remember(key: string): void {
    if (this.negative.size >= NEGATIVE_MAX) this.negative.clear();
    this.negative.set(key, this.now());
  }
}
