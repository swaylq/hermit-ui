// Two decisions about a cron run that went wrong. Both pure, both here rather than
// beside the database calls that use them, because both fail SILENTLY when they are
// wrong — a window whose deadline is already past never fires and is
// indistinguishable from a cron with no window configured, and a staleness bound
// set too low quietly steals live runs. Neither shows up in a typecheck.
//
// finance-agent's scheduler reached the same shape from the same bruises and put a
// config self-test around it (projects/jieniu/src/scheduler/jobs.test.ts, 2026-08-31,
// after one 402 lost a whole morning's pre-open brief). This module is the half of
// that which can be tested without a database.

// ── how long before a run that is still 'running' must be abandoned ──────────
//
// The gateway's own per-run cap (RUN_TIMEOUT_MS in apps/gateway/src/cron-runner.ts)
// plus room for a slow finish POST. Below this, a long run is just a long run: the
// gateway still holds it and will close it itself. Raise the gateway's cap without
// raising this and the sweep starts stealing live runs.
export const RUN_CAP_MS = 2 * 60 * 60_000;
export const GRACE_MS = 15 * 60_000;
export const STALE_MS = RUN_CAP_MS + GRACE_MS;

// Past this, close the row but say nothing. The first sweep after this ships meets
// every orphan any gateway restart ever left behind; pushing about a run from three
// weeks ago is noise, and re-running its task is worse than noise.
export const NOTIFY_MAX_AGE_MS = 24 * 60 * 60_000;

export function classifyStaleRun(a: {
  firedAtMs: number;
  now: number;
  /** How many later runs the same cron already has. */
  supersededBy: number;
}): { stale: boolean; quiet: boolean } {
  const age = a.now - a.firedAtMs;
  return {
    stale: age > STALE_MS,
    // Quiet when it is ancient, OR when a later run has already reported:
    // `lastStatus` then belongs to that newer run, and overwriting it with this
    // corpse's `error` would turn a currently-healthy cron red.
    quiet: age > NOTIFY_MAX_AGE_MS || a.supersededBy > 0,
  };
}

// ── should the failed run be tried again today, and when ─────────────────────

export type RetryDecision =
  | { kind: 'retry'; at: Date; until: Date; attempt: number }
  | { kind: 'giveUp' }
  | { kind: 'none' };

/**
 * ONLY `error` is retried.
 *   - `timeout` is not. Here it means the gateway stopped being able to OBSERVE the
 *     run, not that the run failed — "the scheduled work itself may have completed"
 *     (cron-runner.ts, classifyRun). Re-running a task that may already have done
 *     its job is the expensive wrong guess, and for anything that writes or sends,
 *     the dangerous one.
 *   - `no_output` is not. A turn that settled cleanly and said nothing is usually a
 *     cron that genuinely had nothing to say.
 * A run abandoned by a dead gateway is recorded as `error` by the sweep, because
 * that one IS known not to have finished.
 */
export function decideRetry(a: {
  status: string;
  retryEverySec: number | null;
  retryWindowSec: number | null;
  /** Deadline stamped by the first failure of this fire, if there was one. */
  retryUntil: Date | null;
  retryCount: number;
  /** The fire this finish belongs to; anchors the window. */
  firedAt: Date | null;
  now: number;
}): RetryDecision {
  if (a.status !== 'error') return { kind: 'none' };
  if (!a.retryEverySec || !a.retryWindowSec) return { kind: 'none' };
  // The deadline from the FIRST failure wins for every later attempt, so a catch-up
  // that also fails cannot slide its own deadline forward and turn a bounded window
  // into an unbounded retry loop.
  const anchor =
    a.retryUntil ?? (a.firedAt ? new Date(a.firedAt.getTime() + a.retryWindowSec * 1000) : null);
  if (!anchor) return { kind: 'none' }; // nothing to measure against; do not guess
  const at = new Date(a.now + a.retryEverySec * 1000);
  if (at.getTime() > anchor.getTime()) return { kind: 'giveUp' };
  return { kind: 'retry', at, until: anchor, attempt: a.retryCount + 1 };
}

/**
 * Is this catch-up configuration capable of ever firing?
 *
 * A window shorter than one interval can never produce an attempt, and reads
 * exactly like a working setting. finance-agent shipped the same guard as a test
 * over its job table for precisely this reason. Callers that accept user input
 * (cron.create / cron.update / the MCP tools) should refuse rather than store it.
 */
export function retryConfigProblem(a: {
  retryEverySec: number | null;
  retryWindowSec: number | null;
  intervalSec: number;
}): string | null {
  const { retryEverySec: every, retryWindowSec: win } = a;
  if (every == null && win == null) return null;
  if (every == null || win == null) return '补跑间隔和补跑窗口必须一起设置';
  if (every < 300) return '补跑间隔不能短于 5 分钟';
  if (win < every) return '补跑窗口短于补跑间隔，永远排不出一次补跑';
  if (win >= a.intervalSec) return '补跑窗口不短于任务本身的间隔，等于无限重试';
  return null;
}
