// Transport policy + circuit breaker for every HTTP call this gateway makes to
// the dashboard.
//
// Why it exists — macmini003, 2026-08-06..08. Every dashboard poll failed for
// two days straight with an HTTP/2 stream error:
//
//   [chat] poll failed: [TypeError: fetch failed]
//     [cause]: ERR_HTTP2_STREAM_ERROR: Stream closed with error code
//              NGHTTP2_ENHANCE_YOUR_CALM
//
// ENHANCE_YOUR_CALM is a Go http2 server (Caddy, on the VPS) telling one client
// connection to back off — its post-CVE-2023-44487 rapid-reset defence. Every
// api.ts fetch carries `AbortSignal.timeout`, and under HTTP/2 each firing
// timeout is an RST_STREAM, so a slow patch of dashboard responses looks exactly
// like a reset flood. That part is arguably fair.
//
// What turned a server-side throttle into a two-day outage is ours: the poll
// loops caught the error, logged it, and immediately retried at full rate
// (1732 errors/minute, sustained, for ~28 hours). undici kept reusing the one
// poisoned connection, so the reset counter never decayed and the connection
// never recovered. Restarting the gateway — i.e. getting a new connection —
// fixed it in one second. Messages to all 27 agents on that machine were dead
// the whole time.
//
// So, two defences:
//
//   1. `installDispatcher` pins our own undici Agent with `allowH2: false`, so
//      the gateway can never end up speaking HTTP/2 to the dashboard no matter
//      what Node or some transitive dependency decides the global default is.
//      (`@earendil-works/pi-coding-agent` ships its own `setGlobalDispatcher`
//      call — a dependency owning this process's HTTP stack by side effect is
//      precisely what we don't want.) HTTP/1.1 has no stream multiplexing, so
//      the whole ENHANCE_YOUR_CALM failure mode cannot occur on it.
//
//   2. The breaker below makes the general case self-heal: consecutive
//      transport failures open it, ticks are skipped while it's open, the
//      connection is thrown away so the retry gets a fresh one, and the backoff
//      grows to a 30s ceiling. Protocol-agnostic on purpose — whatever poisons
//      the connection next time, the gateway stops hammering and rotates.
//
// Note the h2 origin was never reproduced: as of 2026-08-08 undici on these
// Macs negotiates HTTP/1.1 with dash.swaylab.ai even with `allowH2: true`
// forced. Defence 2 is the one that matters; defence 1 is cheap insurance.

import { Agent, setGlobalDispatcher } from 'undici';

/** Consecutive failures tolerated before the breaker opens. */
export const FAILURES_BEFORE_OPEN = 3;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Ceiling on simultaneous connections to the dashboard.
 *
 * undici's per-origin pool is unbounded by default, and so was Node's. Measured
 * on macmini003 (2026-08-08, 27 agents): restarting the gateway peaks at ~1018
 * sockets to the dashboard within 6 seconds — attributed to the gateway process
 * itself, not the machine's proxied traffic — and takes ~30s to drain, throwing
 * a few UND_ERR_CONNECT_TIMEOUT on the way. Steady state is 6-9.
 *
 * That is a tenfold spike in the machine's whole non-LISTEN socket count (127 →
 * 1262) for a client that needs single digits, and it lands on hosts whose
 * 16384 ephemeral ports become permanent tombstones the moment they cross the
 * 49.7-day tcp_now bug. 64 leaves ~7x headroom over steady state while bounding
 * the burst 16x; at typical response times the queued remainder drains in a few
 * seconds, nowhere near the 30s request timeout.
 */
export const MAX_CONNECTIONS = 64;

/**
 * Consecutive-failure circuit breaker with exponential backoff.
 *
 * Half-open by construction: once the window elapses `isOpen` goes false, so
 * the next tick probes for real. One success closes it; one failure re-opens it
 * one step wider.
 */
export class Breaker {
  private failures = 0;
  private openUntil = 0;

  constructor(private readonly onOpen: () => void = () => {}) {}

  isOpen(now: number): boolean {
    return now < this.openUntil;
  }

  /** Delay applied at the current failure count — exported for the log line. */
  backoffMs(): number {
    const steps = this.failures - FAILURES_BEFORE_OPEN;
    if (steps < 0) return 0;
    return Math.min(BACKOFF_BASE_MS * 2 ** steps, BACKOFF_MAX_MS);
  }

  noteSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  noteFailure(now: number): void {
    this.failures += 1;
    if (this.failures < FAILURES_BEFORE_OPEN) return;
    this.openUntil = now + this.backoffMs();
    // Drop the connection every time we open, not just on the first trip: the
    // whole point is that the next probe must not reuse whatever is broken.
    this.onOpen();
  }

  /** Test/debug view. */
  get consecutiveFailures(): number {
    return this.failures;
  }
}

let agent: Agent | undefined;

/**
 * Install (or replace) the gateway's dashboard dispatcher. Replacing it is how
 * we throw away a poisoned connection: the new Agent is published first, then
 * the old one is destroyed, so nothing races onto the dying pool.
 */
export function installDispatcher(): void {
  const previous = agent;
  const next = new Agent({ allowH2: false, connections: MAX_CONNECTIONS });
  agent = next;
  setGlobalDispatcher(next);
  previous?.destroy().catch(() => {});
}

export const breaker = new Breaker(() => {
  installDispatcher();
});

/** True when dashboard calls should be skipped outright. */
export function dashboardBackedOff(now: number = Date.now()): boolean {
  return breaker.isOpen(now);
}

export function noteDashboardSuccess(): void {
  const wasFailing = breaker.consecutiveFailures > 0;
  breaker.noteSuccess();
  if (wasFailing) console.log('[dashboard-http] recovered');
}

export function noteDashboardFailure(now: number = Date.now()): void {
  const before = breaker.isOpen(now);
  breaker.noteFailure(now);
  if (!before && breaker.isOpen(now)) {
    console.error(
      `[dashboard-http] ${breaker.consecutiveFailures} consecutive failures — `
      + `dropping the connection and pausing dashboard calls for ${breaker.backoffMs()}ms`);
  }
}
