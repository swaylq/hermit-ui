// The cron run-status domain — the single source of truth for the dashboard.
//
// The gateway's cron-runner settle loop writes these values into Cron.lastStatus /
// CronRun.status as a free-form String (no DB enum — see memory
// hermit-ui-cron-status-semantics), and the dashboard reads them back to render a
// status light in four places: the /cron badge, the agent-detail dot, the sidebar
// recents dot, and the notifications inbox. Those four sites each map a status to
// their OWN classes (a badge triple vs a dot bg vs a boolean), but they all share
// ONE grouping — which is what used to be copy-pasted (and had to be kept in sync)
// across all four. That grouping now lives here exactly once, so adding a status or
// re-grouping one is a single-file change instead of a four-site hunt.
//
// NOTE: the gateway is the *producer* and keeps its own inline union in
// apps/gateway/src/cron-runner.ts (a different package — the dashboard never imports
// gateway internals). That's the one write-side definition; this module is the
// read-side single source the UI consumers share.

export const CRON_STATUS = {
  ok: 'ok', // the turn settled and produced text
  noOutput: 'no_output', // settled but produced no text — inconclusive, not a failure
  timeout: 'timeout', // couldn't confirm completion (2h cap / host suspended) — inconclusive
  error: 'error', // the gateway caught an exception running the turn
  running: 'running', // in flight
  fail: 'fail', // legacy pre-semantics rows — treated like `error` for display
} as const;
export type CronStatus = (typeof CRON_STATUS)[keyof typeof CRON_STATUS];

// The semantic tone a status renders as. Each render site maps tone → its own
// classes; the status→tone grouping is defined only here.
export type CronStatusTone = 'ok' | 'bad' | 'inconclusive' | 'neutral';

export function cronStatusTone(status?: string | null): CronStatusTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'fail': // legacy alias for error
    case 'error':
      return 'bad';
    case 'running':
    case 'timeout':
    case 'no_output':
      return 'inconclusive';
    default:
      return 'neutral';
  }
}
