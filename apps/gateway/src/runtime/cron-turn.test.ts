// runRuntimeCronTurn — one cron fire on a non-pane backend.
//
// Two things here can be wrong in ways nothing else catches, and both of them
// produce a WRONG REPORT rather than a crash:
//
//   • the settle loop. `isWorking` is a round-trip for pi/omp/prime and `submit`
//     only awaits the ack, so there is a real window where a healthy turn reads
//     as idle. Settling inside it reports a working cron as `no_output`.
//   • the collector. No runtime here throws on an expired login or a spent
//     quota — they emit a `system` row and produce no assistant text. Dropping
//     those rows is exactly the blindness that recorded "Login expired · Please
//     run /login" as `ok` eleven times across six agents
//     (memory/notes/bug_cron_false_ok_synthetic.md).
//
// Time is virtual throughout: `sleep` advances the clock, so a 2h deadline costs
// no wall-clock and every case is deterministic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.ASST_KEY ||= 'test-key-unused';
const { runRuntimeCronTurn, canRunCronTurn, isFailureNote } = await import('./cron-turn');
type SyncItem = import('./types').SyncItem;
type AgentRuntime = import('./types').AgentRuntime;

const TIMEOUT_MS = 120 * 60_000; // the runner's RUN_TIMEOUT_MS
const IDLE_MS = 8_000;           // the runner's IDLE_DONE_MS

const text = (t: string) => [{ type: 'text', text: t }];

/** A clock that only moves when the code under test sleeps. */
function virtualClock(startAt = 1_770_000_000_000) {
  let t = startAt;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

type Script = {
  /** Called each poll; return whether the backend is busy. */
  working: (poll: number) => boolean;
  /** Called each poll; anything returned is emitted before the busy check. */
  emits?: (poll: number) => SyncItem[];
  submit?: () => Promise<boolean>;
  ensure?: () => Promise<never>;
};

function fakeRuntime(script: Script) {
  const calls = { ensured: 0, submitted: 0, stopped: [] as string[], polls: 0 };
  let emit: (i: SyncItem) => void = () => {};
  const runtime: AgentRuntime = {
    kind: 'pi-rpc',
    async ensure(_session, e) {
      calls.ensured++;
      emit = e;
      if (script.ensure) await script.ensure();
      return { sessionId: 'cron-run-1', externalSessionId: 'ext-abc' };
    },
    async submit() {
      calls.submitted++;
      return script.submit ? script.submit() : true;
    },
    async isWorking() {
      const poll = calls.polls++;
      for (const item of script.emits?.(poll) ?? []) emit(item);
      return script.working(poll);
    },
    async isLive() { return true; },
    async interrupt() {},
    async compact() {},
    async usage() { return null; },
    async stop(_h, mode) { calls.stopped.push(mode); },
  };
  return { runtime, calls };
}

const run = (script: Script, extra: Record<string, unknown> = {}) => {
  const { runtime, calls } = fakeRuntime(script);
  const clock = virtualClock();
  return {
    calls,
    result: runRuntimeCronTurn({
      harness: 'pi-rpc',
      mode: 'omp',
      agentName: 'tester',
      cwd: '/Users/test/agent',
      prompt: 'do the thing',
      sessionId: 'cron-run-1',
      credentialId: 'cred-1',
      provider: 'kimi',
      model: 'k2',
      isOrchestrator: false,
      timeoutMs: TIMEOUT_MS,
      idleMs: IDLE_MS,
      runtime,
      ...clock,
      ...extra,
    }),
  };
};

describe('runRuntimeCronTurn — collecting the answer', () => {
  it('reports the assistant text and settles', async () => {
    const { result, calls } = run({
      working: (p) => p < 3,
      emits: (p) => (p === 2 ? [{ sessionId: 's', role: 'assistant', content: text('all green'), externalId: 'a1', claudeSessionId: null }] : []),
    });
    const r = await result;
    assert.equal(r.text, 'all green');
    assert.equal(r.settled, true);
    assert.equal(r.harnessNote, '');
    assert.equal(calls.submitted, 1);
  });

  it('keeps the LAST assistant message, not the first', async () => {
    const r = await run({
      working: (p) => p < 4,
      emits: (p) => {
        if (p === 1) return [{ sessionId: 's', role: 'assistant', content: text('working on it'), externalId: 'a1', claudeSessionId: null }];
        if (p === 3) return [{ sessionId: 's', role: 'assistant', content: text('done: 4 items'), externalId: 'a2', claudeSessionId: null }];
        return [];
      },
    }).result;
    assert.equal(r.text, 'done: 4 items');
  });

  // claude-sdk streams into a placeholder row and retracts it when the real
  // message lands — and emits a bare retraction before the turn even starts.
  // Taking either as the answer reports a half-written sentence as the result.
  it('ignores the streaming placeholder and its retraction', async () => {
    const r = await run({
      working: (p) => p < 4,
      emits: (p) => {
        if (p === 0) return [{ sessionId: 's', role: 'assistant', content: [], externalId: 'live', claudeSessionId: null, deleted: true }];
        if (p === 1) return [{ sessionId: 's', role: 'assistant', content: text('all gr'), externalId: 'live', claudeSessionId: null, transient: true }];
        if (p === 2) return [{ sessionId: 's', role: 'assistant', content: text('all green'), externalId: 'a1', claudeSessionId: null }];
        return [];
      },
    }).result;
    assert.equal(r.text, 'all green');
  });

  it('does not mistake thinking or tool_use blocks for an answer', async () => {
    const r = await run({
      working: (p) => p < 3,
      emits: (p) => (p === 1 ? [{
        sessionId: 's', role: 'assistant', externalId: 'a1', claudeSessionId: null,
        content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      }] : []),
    }).result;
    assert.equal(r.text, '');
    assert.equal(r.settled, true, 'a tool-only turn still settles — it just said nothing');
  });

  it('does not report tool results (role user) as the answer', async () => {
    const r = await run({
      working: (p) => p < 3,
      emits: (p) => (p === 1 ? [{
        sessionId: 's', role: 'user', externalId: 'u1', claudeSessionId: null,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret file contents' }],
      }] : []),
    }).result;
    assert.equal(r.text, '');
    assert.equal(r.harnessNote, '');
  });
});

// The failures that used to be invisible.
describe('runRuntimeCronTurn — what the backend said went wrong', () => {
  it('collects a system row as a harness note, with no assistant text', async () => {
    const r = await run({
      working: () => false,
      emits: (p) => (p === 0 ? [{
        sessionId: 's', role: 'system', externalId: 'sys1', claudeSessionId: null,
        content: text('[pi error — the turn did not complete]\nauthentication_failed'),
      }] : []),
    }).result;
    assert.equal(r.text, '');
    assert.match(r.harnessNote, /authentication_failed/);
  });

  it('keeps a note alongside a real answer rather than dropping either', async () => {
    const r = await run({
      working: (p) => p < 3,
      emits: (p) => {
        if (p === 1) return [{ sessionId: 's', role: 'assistant', content: text('report body'), externalId: 'a1', claudeSessionId: null }];
        if (p === 2) return [{ sessionId: 's', role: 'system', content: text('[gateway] ⚠️ rate limited'), externalId: 'sys1', claudeSessionId: null }];
        return [];
      },
    }).result;
    assert.equal(r.text, 'report body');
    assert.match(r.harnessNote, /rate limited/);
  });

  it('does not repeat a complaint the backend repeats', async () => {
    const r = await run({
      working: () => false,
      emits: () => [{ sessionId: 's', role: 'system', content: text('[pi session ended — child exited]'), externalId: 'sys1', claudeSessionId: null }],
    }).result;
    assert.equal(r.harnessNote, '[pi session ended — child exited]');
  });

  // pi/omp/prime return false from submit() for a dead child and emit the REASON
  // separately. Throwing a generic "refused" would replace the reason with a
  // sentence that says only that something went wrong.
  it('a refused submit reports the backend’s own reason, not a generic one', async () => {
    const { runtime, calls } = fakeRuntime({
      working: () => false,
      submit: async () => false,
    });
    // Emit the reason the way evict() does — during ensure, before submit.
    const clock = virtualClock();
    const r = await runRuntimeCronTurn({
      harness: 'pi-rpc', mode: 'omp', agentName: 'tester', cwd: '/tmp/a',
      prompt: 'p', sessionId: 'cron-run-1', credentialId: null, provider: null,
      model: null, isOrchestrator: false, timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS,
      runtime, ...clock,
    });
    assert.equal(r.settled, true);
    assert.match(r.harnessNote, /refused the prompt/);
    assert.deepEqual(calls.stopped, ['kill']);
  });
});

describe('runRuntimeCronTurn — settling', () => {
  // The premature-settle case. A backend that has not picked the turn up yet
  // reads idle; settling there reports a healthy cron as no_output.
  it('does not settle while the backend has not started, then settles when it does', async () => {
    const r = await run({
      // Idle for the first 40 polls (~40s), then works, then goes quiet.
      working: (p) => p >= 40 && p < 60,
      emits: (p) => (p === 55 ? [{ sessionId: 's', role: 'assistant', content: text('late but fine'), externalId: 'a1', claudeSessionId: null }] : []),
    }).result;
    assert.equal(r.text, 'late but fine', 'a slow-starting backend must not be cut off');
    assert.equal(r.settled, true);
  });

  it('gives up on a backend that never speaks, without burning the whole cap', async () => {
    const { result } = run({ working: () => false });
    const r = await result;
    assert.equal(r.text, '');
    assert.equal(r.settled, true, 'settled+empty is no_output — a definite answer, not a timeout');
  });

  it('never settling is reported as not settled', async () => {
    // Busy forever ⇒ falls through the deadline.
    const r = await run({ working: () => true }).result;
    assert.equal(r.settled, false);
  });

  it('a turn that stays busy past the cap still reports what it managed to say', async () => {
    const r = await run({
      working: () => true,
      emits: (p) => (p === 5 ? [{ sessionId: 's', role: 'assistant', content: text('partial'), externalId: 'a1', claudeSessionId: null }] : []),
    }).result;
    assert.equal(r.settled, false);
    assert.equal(r.text, 'partial');
  });
});

describe('runRuntimeCronTurn — lifecycle', () => {
  it('kills the session however the turn ended', async () => {
    const { result, calls } = run({ working: (p) => p < 2 });
    await result;
    assert.deepEqual(calls.stopped, ['kill'], 'never hibernate — a cron session has no future');
  });

  it('kills the session even when the turn throws', async () => {
    const { runtime, calls } = fakeRuntime({
      working: () => false,
      submit: async () => { throw new Error('boom'); },
    });
    const clock = virtualClock();
    await assert.rejects(() => runRuntimeCronTurn({
      harness: 'pi-rpc', mode: 'omp', agentName: 'tester', cwd: '/tmp/a',
      prompt: 'p', sessionId: 'cron-run-1', credentialId: null, provider: null,
      model: null, isOrchestrator: false, timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS,
      runtime, ...clock,
    }), /boom/);
    assert.deepEqual(calls.stopped, ['kill']);
  });

  it('reports the backend’s session id so the fire can be marked cron-owned', async () => {
    const seen: string[] = [];
    await run({ working: (p) => p < 2 }, { onStarted: (u: string) => seen.push(u) }).result;
    assert.deepEqual(seen, ['ext-abc']);
  });

  // The pane path has always withheld the machine key from an ordinary cron
  // (cron-runner → cronPaneEnv, pinned by its own test). Moving crons off the
  // pane must not quietly hand it back: the hermit tools act on
  // HERMIT_SESSION_ID, and a cron's id has no ChatSession row behind it, so they
  // would 404 while the credential sat in every tool subprocess.
  it('withholds the hermit tools and the machine key from an ordinary cron', async () => {
    let seen: boolean | undefined;
    const { runtime } = fakeRuntime({ working: (p) => p < 2 });
    const inner = runtime.ensure.bind(runtime);
    runtime.ensure = async (session, emit) => { seen = session.hermitTools; return inner(session, emit); };
    const clock = virtualClock();
    await runRuntimeCronTurn({
      harness: 'claude-sdk', mode: null, agentName: 'tester', cwd: '/tmp/a',
      prompt: 'p', sessionId: 'cron-run-1', credentialId: null, provider: null,
      model: null, isOrchestrator: false, timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS,
      runtime, ...clock,
    });
    assert.equal(seen, false);
  });

  it('gives them to the orchestrator, whose crons need the brain tools', async () => {
    let seen: boolean | undefined;
    const { runtime } = fakeRuntime({ working: (p) => p < 2 });
    const inner = runtime.ensure.bind(runtime);
    runtime.ensure = async (session, emit) => { seen = session.hermitTools; return inner(session, emit); };
    const clock = virtualClock();
    await runRuntimeCronTurn({
      harness: 'claude-sdk', mode: null, agentName: 'brain', cwd: '/tmp/a',
      prompt: 'p', sessionId: 'cron-run-1', credentialId: null, provider: null,
      model: null, isOrchestrator: true, timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS,
      runtime, ...clock,
    });
    assert.equal(seen, true);
  });

  it('asks for a fresh turn — never a resume', async () => {
    let sawExternal: string | null | undefined = 'unset';
    const { runtime } = fakeRuntime({ working: (p) => p < 2 });
    const inner = runtime.ensure.bind(runtime);
    runtime.ensure = async (session, emit) => { sawExternal = session.externalSessionId; return inner(session, emit); };
    const clock = virtualClock();
    await runRuntimeCronTurn({
      harness: 'pi-rpc', mode: 'omp', agentName: 'tester', cwd: '/tmp/a',
      prompt: 'p', sessionId: 'cron-run-1', credentialId: null, provider: null,
      model: null, isOrchestrator: false, timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS,
      runtime, ...clock,
    });
    assert.equal(sawExternal, null);
  });
});

describe('canRunCronTurn', () => {
  // claude-tmux is not an AgentRuntime — it belongs on cron-runner's pane path,
  // which is also what every cron did before backends existed.
  it('declines claude-tmux and unknown harnesses, so they fall back to the pane', () => {
    assert.equal(canRunCronTurn('claude-tmux', null), false);
    assert.equal(canRunCronTurn('not-a-harness', null), false);
    assert.equal(canRunCronTurn(null, null), false);
  });

  it('accepts every backend a user can actually pick', () => {
    for (const kind of ['claude-sdk', 'codex-exec', 'dsh-exec', 'prime-rpc']) {
      assert.equal(canRunCronTurn(kind, null), true, kind);
    }
    // pi needs its mode: runtimeFor picks the omp engine or the pi one from it.
    assert.equal(canRunCronTurn('pi-rpc', 'omp'), true);
    assert.equal(canRunCronTurn('pi-rpc', 'coding'), true);
  });
});

// Both of these were found by review, after the first version shipped green.
// They are the same class of bug the settle loop exists to prevent — a HEALTHY
// cron declared finished while its turn is still running — approached from two
// directions the original guards did not cover.
describe('runRuntimeCronTurn — settling, the cases that got it wrong', () => {
  // Bug 1: `lastActiveAt` used to be anchored to the start of the fire, and only
  // a BUSY reading moved it. Everything else the backend emitted — tool calls,
  // tool results, narration — counted for nothing. So a turn that was plainly
  // alive but whose backend happened to answer `isWorking` false (pi and prime
  // answer it with a `get_state` round-trip, and return false on any error)
  // was declared finished 8s after the FIRE started, not 8s after it last did
  // anything. The pane path never had this bug: every transcript line bumps
  // lastEventAt. Now every emitted item does the same here.
  it('tool traffic alone keeps a turn alive past the start grace', async () => {
    const r = await run({
      working: () => false, // the backend never admits to being busy
      emits: (p) => {
        // Steady tool traffic well past START_GRACE_MS (120 polls ≈ 120s)…
        if (p < 200 && p % 5 === 0) {
          return [{ sessionId: 's', role: 'user', externalId: `t${p}`, claudeSessionId: null,
                    content: [{ type: 'tool_result', tool_use_id: `t${p}`, content: 'ok' }] }];
        }
        // …and only then the answer.
        if (p === 200) return [{ sessionId: 's', role: 'assistant', content: text('finished after a long tool run'), externalId: 'a1', claudeSessionId: null }];
        return [];
      },
    }).result;
    assert.equal(r.text, 'finished after a long tool run', 'a live turn must not be cut off at the grace boundary');
    assert.equal(r.settled, true);
  });

  // The flip side, so the fix above cannot become "never settles": once the
  // backend genuinely goes quiet, idleMs still ends the turn.
  it('still settles once the traffic actually stops', async () => {
    const { result, calls } = run({
      working: () => false,
      emits: (p) => (p === 3
        ? [{ sessionId: 's', role: 'assistant', content: text('done'), externalId: 'a1', claudeSessionId: null }]
        : []),
    });
    const r = await result;
    assert.equal(r.settled, true);
    assert.equal(r.text, 'done');
    assert.ok(calls.polls < 60, `should not burn the whole cap on a finished turn; polled ${calls.polls}`);
  });

  // Bug 2: the start grace used to run from before ensure(), so a slow spawn
  // (pi reads the encrypted secret store through subprocesses first) ate the
  // window meant to cover the backend's first token.
  it('a slow spawn does not eat the start grace', async () => {
    const { runtime, calls } = fakeRuntime({ working: (p) => p >= 100 && p < 140 });
    const clock = virtualClock();
    const slow = {
      ...runtime,
      ensure: async (sess: any, emit: any) => { await clock.sleep(90_000); return runtime.ensure(sess, emit); },
    };
    const r = await runRuntimeCronTurn({
      harness: 'pi-rpc', mode: 'omp', agentName: 'tester', cwd: '/tmp/a',
      prompt: 'p', sessionId: 'cron-run-1', credentialId: null, provider: null,
      model: null, isOrchestrator: false, timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS,
      runtime: slow as any, ...clock,
    });
    assert.equal(r.settled, true);
    assert.ok(calls.polls > 100, `the turn must survive a 90s spawn; polled ${calls.polls}`);
  });
});

describe('isFailureNote', () => {
  it('recognises what each backend says when a turn actually failed', () => {
    for (const t of [
      '[pi error — the turn did not complete]\nauthentication_failed',
      '[pi could not start]\nENOENT',
      '[pi session ended — child exited]',
      '[pi is on the wrong provider]\nAsked for "kimi"',
      '[omp session ended — drained]',
      '[Prime Agent could not start]',
      '[dsh could not run this turn]\nstderr tail',
      '[dsh — the turn ended: rate_limited]',
      '[kimi could not run this turn]\nkimi exited 1 — the turn produced nothing',
      '[kimi could not start — the CLI is not installed on this machine]',
      '[kimi could not start — no endpoint to run against: the secret KIMI_API_KEY is not in this machine\'s store]',
      '[gateway] ⚠️ 这一轮没有正常结束：authentication_failed',
      '[turn interrupted]',
    ]) assert.equal(isFailureNote(t), true, t.split('\n')[0]);
  });

  // The whole point of the split: these arrive on the same channel and are not
  // failures. Calling them failures fires a failure push on a healthy run.
  it('does not flag routine narration', () => {
    for (const t of [
      '[gateway] ⏱️ 一条命令跑了 200s 还没结束，已转入后台，这一轮继续。',
      '[gateway] 🗜️ 上下文已自动压缩（120k → 40k）',
      '```\n$ ls\nREADME.md\n```',
      'plain output with no marker at all',
      '[gateway] ⏹️ 已停止',
      // A retry the CLI usually wins. Flagging it would colour a turn that
      // finished fine — the exact thing this split exists to prevent.
      '[kimi — model call failed 429 (attempt 1/3), retrying in 1.5s]\ntoo many requests',
      '[kimi session 2d0aad4f]',
      '[kimi manages its own context window — there is nothing to compact by hand]',
    ]) assert.equal(isFailureNote(t), false, t.split('\n')[0]);
  });
});
