// The drain only ever runs while the process is dying, which is the one place
// nobody is watching and no log survives to be read later. Four cases, each one
// a shape that was genuinely broken before this module existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drainSessions, CUT_NOTICE, type DrainRuntime, type DrainDeps } from './shutdown-drain';

interface Recorder {
  notices: Array<{ sessionId: string; text: string }>;
  interrupted: string[];
  stopped: Array<{ sessionId: string; mode: string }>;
  logs: string[];
  clock: number;
}

function harness(runtimes: DrainRuntime[]): { deps: DrainDeps; rec: Recorder } {
  const rec: Recorder = { notices: [], interrupted: [], stopped: [], logs: [], clock: 0 };
  const deps: DrainDeps = {
    runtimes,
    now: () => rec.clock,
    // Virtual time: the budget is asserted, not waited out.
    sleep: async (ms) => { rec.clock += ms; },
    postNotice: async (sessionId, _externalId, text) => { rec.notices.push({ sessionId, text }); },
    log: (l) => rec.logs.push(l),
  };
  return { deps, rec };
}

function fakeRuntime(
  kind: string,
  ids: string[],
  working: (sessionId: string, call: number) => boolean | Promise<boolean>,
  rec: () => Recorder,
): DrainRuntime {
  const calls = new Map<string, number>();
  return {
    kind,
    liveSessionIds: () => ids,
    async isWorking(h) {
      const n = calls.get(h.sessionId) ?? 0;
      calls.set(h.sessionId, n + 1);
      return await working(h.sessionId, n);
    },
    async interrupt(h) { rec().interrupted.push(h.sessionId); },
    async stop(h, mode) { rec().stopped.push({ sessionId: h.sessionId, mode }); },
  };
}

test('a turn that finishes inside the budget is not cut, and the session still gets closed', async () => {
  let rec!: Recorder;
  // Busy for the first two polls, done on the third.
  const rt = fakeRuntime('claude-sdk', ['s1'], (_id, call) => call < 2, () => rec);
  const h = harness([rt]);
  rec = h.rec;

  const report = await drainSessions(h.deps, { budgetMs: 20_000, pollMs: 250, stampMs: 1 });

  assert.equal(report.cut, 0);
  assert.equal(report.finished, 1);
  assert.deepEqual(rec.notices, [], 'a turn that finished must not be told it was interrupted');
  assert.deepEqual(rec.interrupted, []);
  // Held is not the same question as busy: the child is still there either way.
  assert.deepEqual(rec.stopped, [{ sessionId: 's1', mode: 'hibernate' }]);
});

test('a turn that outlives the budget is told first, then interrupted, then closed', async () => {
  let rec!: Recorder;
  const rt = fakeRuntime('claude-sdk', ['s1'], () => true, () => rec);
  const h = harness([rt]);
  rec = h.rec;

  const report = await drainSessions(h.deps, { budgetMs: 1_000, pollMs: 250, interruptGraceMs: 10, stampMs: 7 });

  assert.equal(report.cut, 1);
  assert.equal(rec.notices.length, 1);
  assert.equal(rec.notices[0]!.text, CUT_NOTICE);
  assert.deepEqual(rec.interrupted, ['s1']);
  assert.deepEqual(rec.stopped, [{ sessionId: 's1', mode: 'hibernate' }]);
  assert.ok(report.waitedMs >= 1_000, 'must actually have waited the budget out');
});

test('every backend is drained, not just the one that used to be', async () => {
  let rec!: Recorder;
  // The exact gap this replaces: shutdown() closed claude-sdk and left the rest.
  const runtimes = ['claude-sdk', 'codex-exec', 'kimi-code', 'dsh-exec', 'pi-rpc'].map((k, i) =>
    fakeRuntime(k, [`s${i}`], () => false, () => rec));
  const h = harness(runtimes);
  rec = h.rec;

  const report = await drainSessions(h.deps, { budgetMs: 20_000, stampMs: 1 });

  assert.equal(report.held, 5);
  assert.equal(rec.stopped.length, 5);
});

test('a backend that cannot answer is treated as idle, not as a reason to hold the restart open', async () => {
  let rec!: Recorder;
  const broken = fakeRuntime('kimi-code', ['s1'], () => { throw new Error('boom'); }, () => rec);
  const h = harness([broken]);
  rec = h.rec;

  const report = await drainSessions(h.deps, { budgetMs: 20_000, pollMs: 250, stampMs: 1 });

  assert.equal(report.busy, 0);
  assert.equal(report.waitedMs, 0, 'a throwing isWorking must not burn the whole budget');
  assert.deepEqual(rec.stopped, [{ sessionId: 's1', mode: 'hibernate' }]);
});
