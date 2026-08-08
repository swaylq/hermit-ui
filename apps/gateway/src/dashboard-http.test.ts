// Regression cover for the macmini003 2026-08-06..08 outage: dashboard polls
// failed for two days at 1732 errors/minute because a failing HTTP call led
// straight back to another HTTP call, on the same poisoned connection, forever.
//
// The production conditions being pinned here are: (a) a sustained failure run
// must eventually stop issuing calls, (b) each time it gives up it must drop
// the connection so the next probe is fresh, (c) it must still probe — a
// breaker that never reopens is just a slower outage, and (d) recovery must be
// immediate once the dashboard answers again.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  Breaker, FAILURES_BEFORE_OPEN, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
  MAX_CONNECTIONS, installDispatcher,
} from './dashboard-http';

describe('Breaker', () => {
  it('stays closed while failures are below the threshold', () => {
    const b = new Breaker();
    for (let i = 0; i < FAILURES_BEFORE_OPEN - 1; i++) b.noteFailure(1000);
    assert.equal(b.isOpen(1000), false, 'a blip must not pause polling');
  });

  it('opens once the threshold is reached, for the base delay', () => {
    const b = new Breaker();
    for (let i = 0; i < FAILURES_BEFORE_OPEN; i++) b.noteFailure(1000);
    assert.equal(b.isOpen(1000), true);
    assert.equal(b.isOpen(1000 + BACKOFF_BASE_MS - 1), true);
    assert.equal(b.isOpen(1000 + BACKOFF_BASE_MS), false, 'must reopen to probe');
  });

  it('backs off exponentially and caps out', () => {
    const b = new Breaker();
    for (let i = 0; i < FAILURES_BEFORE_OPEN; i++) b.noteFailure(0);
    assert.equal(b.backoffMs(), BACKOFF_BASE_MS);
    b.noteFailure(0);
    assert.equal(b.backoffMs(), BACKOFF_BASE_MS * 2);
    b.noteFailure(0);
    assert.equal(b.backoffMs(), BACKOFF_BASE_MS * 4);
    for (let i = 0; i < 50; i++) b.noteFailure(0);
    assert.equal(b.backoffMs(), BACKOFF_MAX_MS, 'never grows past the ceiling');
  });

  it('drops the connection on every open, not just the first', () => {
    let rotations = 0;
    const b = new Breaker(() => { rotations++; });
    for (let i = 0; i < FAILURES_BEFORE_OPEN; i++) b.noteFailure(0);
    assert.equal(rotations, 1);
    b.noteFailure(0);
    b.noteFailure(0);
    assert.equal(rotations, 3, 'each retry must get a fresh connection');
  });

  it('closes immediately on success', () => {
    const b = new Breaker();
    for (let i = 0; i < FAILURES_BEFORE_OPEN + 4; i++) b.noteFailure(0);
    assert.equal(b.isOpen(0), true);
    b.noteSuccess();
    assert.equal(b.isOpen(0), false);
    assert.equal(b.consecutiveFailures, 0);
    assert.equal(b.backoffMs(), 0, 'backoff resets, so the next blip is cheap again');
  });

  it('a two-day failure run issues probes, not a flood', () => {
    // Replays the real incident shape: every tick fails. Count how many calls
    // would actually reach the network across 28 hours of 2s polling.
    const b = new Breaker();
    let attempts = 0;
    const TICK_MS = 2_000;
    const HOURS = 28;
    for (let t = 0; t < HOURS * 3600_000; t += TICK_MS) {
      if (b.isOpen(t)) continue;
      attempts++;
      b.noteFailure(t);
    }
    const unthrottled = (HOURS * 3600_000) / TICK_MS;
    assert.ok(attempts < unthrottled / 10, `expected heavy throttling, got ${attempts}/${unthrottled}`);
    // At the 30s ceiling: ~2 probes/minute. Enough to notice recovery fast.
    assert.ok(attempts > HOURS * 60, `must keep probing, got only ${attempts}`);
  });
});

describe('installDispatcher', () => {
  // Pins the ceiling end-to-end — through Node's global fetch, our undici Agent
  // and a real socket — rather than trusting that the option was passed. The
  // regression it guards: an unbounded pool peaked at ~1018 sockets to the
  // dashboard on every gateway restart on macmini003.
  it('never opens more than MAX_CONNECTIONS sockets to one origin', async () => {
    let live = 0;
    let peak = 0;
    const server = http.createServer((_req, res) => {
      live++;
      peak = Math.max(peak, live);
      setTimeout(() => { live--; res.end('ok'); }, 20);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };

    installDispatcher();
    try {
      const url = `http://127.0.0.1:${port}/`;
      await Promise.all(Array.from({ length: 200 }, () => fetch(url).then((r) => r.text())));
      assert.ok(peak > 1, `expected real concurrency, saw peak ${peak}`);
      assert.ok(peak <= MAX_CONNECTIONS, `peak ${peak} exceeded the ${MAX_CONNECTIONS} ceiling`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
