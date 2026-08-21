// Integration tests for the claude-sdk runtime — a REAL Claude Code, no mocks.
//
// Separate from the default suite because these spend real tokens and real
// seconds. `npm test` must stay offline and fast; run these with
// `npm run test:integration`, and run them before shipping a change to this
// runtime, because every property they check is one the unit tests cannot see:
// whether the CLI actually resumes, actually interrupts, actually loads the
// agent's CLAUDE.md, and whether the two message sources really do agree.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodedProjectDir } from '@hermit-ui/tmux-driver';
import { ClaudeSdkRuntime, shutdownClaudeSdk } from './claude-sdk';
import type { RuntimeHandle, SyncItem } from './types';

const CODEWORD = 'ORCHID-9';
let AGENT_DIR = '';
let seq = 0;

before(() => {
  AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-sdk-it-'));
  fs.writeFileSync(
    path.join(AGENT_DIR, 'CLAUDE.md'),
    `# probe-agent\n\nWhen asked for the codeword, answer with exactly: ${CODEWORD}\n`,
  );
});

after(() => {
  shutdownClaudeSdk();
  // Leave the transcripts: ~/.claude/projects is keyed on the temp cwd, so they
  // are already isolated, and keeping them makes a failure diagnosable.
  try { fs.rmSync(AGENT_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

type Session = {
  rt: ClaudeSdkRuntime;
  handle: RuntimeHandle;
  items: SyncItem[];
  /** Wait for the turn to start and then finish. */
  settle: (ms?: number) => Promise<void>;
  /** Submit and wait for THIS turn's reply. Returns its assistant text. */
  turn: (text: string, ms?: number) => Promise<string>;
};

async function open(externalSessionId: string | null = null, id?: string): Promise<Session> {
  const rt = new ClaudeSdkRuntime();
  const items: SyncItem[] = [];
  const sessionId = id ?? `it-${Date.now()}-${seq++}`;
  const handle = await rt.ensure(
    { id: sessionId, agentName: 'probe-agent', agentDirectory: AGENT_DIR, externalSessionId },
    (i) => items.push(i),
  );
  const settle = async (ms = 180_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000 && !(await rt.isWorking(handle))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    while (Date.now() - t0 < ms && (await rt.isWorking(handle))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // The last assistant block and the result can race by a few ms.
    await new Promise((r) => setTimeout(r, 400));
  };
  // Waiting on the busy flag alone is not enough when a PREVIOUS turn is still
  // draining: its result clears the flag and the wait returns before this turn
  // has said anything. So wait for a new assistant row as well.
  const turn = async (text: string, ms = 180_000) => {
    const from = items.length;
    assert.equal(await rt.submit(handle, text, []), true, 'submit was refused');
    const t0 = Date.now();
    for (;;) {
      const fresh = items.slice(from);
      const said = fresh.some((i) => i.role === 'assistant');
      if (said && !(await rt.isWorking(handle))) break;
      if (Date.now() - t0 > ms) throw new Error(`turn did not complete in ${ms}ms: ${JSON.stringify(text)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 300));
    return textOf(items.slice(from));
  };
  return { rt, handle, items, settle, turn };
}

const textOf = (items: SyncItem[]) =>
  items
    .filter((i) => i.role === 'assistant')
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

// ── the basic round trip ────────────────────────────────────────────────────

test('a turn round-trips, with the agent\'s CLAUDE.md loaded', async () => {
  const s = await open();
  const said = await s.turn('What is the codeword? Answer with the word only.');
  assert.match(said, new RegExp(CODEWORD), 'the agent memory was not loaded');

  // CLAUDE.md is the proof that `settingSources` defaults to the CLI's own
  // behaviour. If the SDK ever stops loading project settings by default, every
  // agent silently loses its instructions — and this is the test that says so.
  const assistantRows = s.items.filter((i) => i.role === 'assistant');
  assert.ok(assistantRows.length >= 1);
  // The first row carries the stamp so the DB learns which transcript this is.
  assert.equal(s.items[0].claudeSessionId, s.handle.externalSessionId);
  assert.equal(s.items[1]?.claudeSessionId ?? null, null, 'the stamp rides exactly one row');

  await s.rt.stop(s.handle, 'kill');
});

test('the session id it reports is the transcript it actually writes', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say OK', []);
  await s.settle();

  const p = path.join(encodedProjectDir(AGENT_DIR), `${s.handle.externalSessionId}.jsonl`);
  assert.ok(fs.existsSync(p), `no transcript at ${p}`);
  assert.ok(fs.statSync(p).size > 0);

  // Every emitted row's externalId is a real record in that transcript. This is
  // the property the pane path could never assert — it had to GUESS which file
  // its process was writing, and three separate incidents came from guessing
  // wrong.
  const uuids = new Set(
    fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l).uuid; } catch { return null; } })
      .filter(Boolean),
  );
  for (const item of s.items.filter((i) => i.role !== 'system')) {
    assert.ok(uuids.has(item.externalId), `row ${item.externalId} is not in the transcript`);
  }

  await s.rt.stop(s.handle, 'kill');
});

test('no row is ever emitted twice, even with both sources running', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say OK', []);
  await s.settle();
  // The SDK stream and the JSONL tail both carry every record. If the dedup
  // funnel were wrong, the chat would show each reply twice.
  const ids = s.items.map((i) => i.externalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate rows: ${ids.join(', ')}`);
  await s.rt.stop(s.handle, 'kill');
});

// ── waking an old conversation ──────────────────────────────────────────────

test('a stopped session wakes with its history intact', async () => {
  const first = await open();
  await first.rt.submit(first.handle, `Remember this number: 40817. Reply "stored".`, []);
  await first.settle();
  const uuid = first.handle.externalSessionId;
  await first.rt.stop(first.handle, 'hibernate');

  // A different runtime instance with empty module state — the shape of a
  // gateway restart.
  const woken = await open(uuid);
  const t0 = Date.now();
  assert.equal(woken.handle.externalSessionId, uuid, 'woke into a different conversation');
  const recalled = await woken.turn('What number did I ask you to remember? Digits only.');
  const wakeMs = Date.now() - t0;

  assert.match(recalled, /40817/, 'history was lost across the wake');
  // The pane path answered an in-TUI "resume from summary / full" prompt to get
  // here, with a timeout that scaled to 240s + 60s per MB of transcript. The SDK
  // lane has no such dialog. This bound is deliberately loose — it is a
  // regression guard, not a benchmark.
  assert.ok(wakeMs < 120_000, `waking took ${wakeMs}ms`);
  console.log(`      ↳ wake + answer: ${wakeMs}ms`);

  await woken.rt.stop(woken.handle, 'kill');
});

test('a pruned transcript starts a fresh session instead of failing forever', async () => {
  // The recorded id points at a conversation that no longer exists on disk —
  // Claude Code's own 30-day retention does this. The pane path retried the
  // resume on every tick and the queued message never landed.
  const s = await open('4f1c3e2a-0000-4000-8000-000000000000');
  assert.notEqual(s.handle.externalSessionId, '4f1c3e2a-0000-4000-8000-000000000000');
  assert.match(await s.turn('Say OK'), /OK/i);
  await s.rt.stop(s.handle, 'kill');
});

// The gateway-restart gap: a turn completes while nothing is listening. The
// backstop tail replays it on the next attach, which is the whole reason this
// runtime reads two sources instead of one.
test('the JSONL backstop replays what the live stream missed', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say PINEAPPLE', []);
  await s.settle();
  const uuid = s.handle.externalSessionId;
  const before = s.items.filter((i) => i.role === 'assistant').map((i) => i.externalId);
  assert.ok(before.length > 0);
  await s.rt.stop(s.handle, 'kill');

  // Re-attach with a fresh collector and run NO new turn. Everything that
  // arrives came from the transcript.
  const again = await open(uuid);
  await new Promise((r) => setTimeout(r, 4_000));
  const replayed = again.items.filter((i) => i.role === 'assistant').map((i) => i.externalId);
  for (const id of before) {
    assert.ok(replayed.includes(id), `row ${id} was not recovered from the transcript`);
  }
  assert.match(textOf(again.items), /PINEAPPLE/);
  await again.rt.stop(again.handle, 'kill');
});

// ── the message-queue gate ──────────────────────────────────────────────────

test('isWorking is true for the whole turn and false either side of it', async () => {
  const s = await open();
  assert.equal(await s.rt.isWorking(s.handle), false, 'busy before anything was sent');

  await s.rt.submit(s.handle, 'Say OK', []);
  // The gate must close on submit, not when the first token arrives — otherwise
  // the next tick delivers a second message into a turn that is already running.
  assert.equal(await s.rt.isWorking(s.handle), true, 'the gate did not close on submit');

  await s.settle();
  assert.equal(await s.rt.isWorking(s.handle), false, 'still busy after the turn ended');
  await s.rt.stop(s.handle, 'kill');
});

test('a stopped session reports idle rather than pinned busy', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say OK', []);
  await s.rt.stop(s.handle, 'kill');
  assert.equal(await s.rt.isWorking(s.handle), false);
});

// ── interrupting ────────────────────────────────────────────────────────────

test('a running turn can be interrupted, and the session survives it', async () => {
  const s = await open();
  // A turn that is slow for a reason the model cannot shortcut. Asking it to
  // count to 500 is not enough — it emits the whole list in one block in about
  // two seconds, so the "interrupt" lands after the work is already done.
  await s.rt.submit(s.handle, 'Run `sleep 45` with the Bash tool, then say DONE.', []);

  const t0 = Date.now();
  while (Date.now() - t0 < 15_000 && !(await s.rt.isWorking(s.handle))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(await s.rt.isWorking(s.handle), true);
  // Let it get properly into the tool call before pulling the plug.
  await new Promise((r) => setTimeout(r, 4_000));

  await s.rt.interrupt(s.handle);
  assert.equal(await s.rt.isWorking(s.handle), false, 'the gate stayed shut after an interrupt');

  // Give the aborted turn's result time to land.
  await new Promise((r) => setTimeout(r, 3_000));
  const said = JSON.stringify(s.items);
  assert.doesNotMatch(said, /DONE/, 'the turn ran to completion — it was not interrupted');
  // A Stop the user asked for must not be reported as a failure.
  assert.match(said, /已停止/, 'no stop marker');
  assert.doesNotMatch(said, /没有正常结束/, 'a deliberate Stop was reported as an error');

  // …and the session is still usable. On the pane an interrupt was an Escape
  // keypress with no acknowledgement that anything had received it.
  assert.match(await s.turn('Say ALIVE'), /ALIVE/);
  await s.rt.stop(s.handle, 'kill');
});

// ── tools, slash commands, images ───────────────────────────────────────────

test('a tool call produces both the call and its result', async () => {
  const s = await open();
  const said = await s.turn('Run the shell command `echo HERMIT_OK` and tell me what it printed.');
  assert.match(said, /HERMIT_OK/);

  const blocks = s.items.flatMap((i) => (Array.isArray(i.content) ? i.content : [])) as any[];
  assert.ok(blocks.some((b) => b?.type === 'tool_use'), 'no tool_use row reached the chat');
  assert.ok(blocks.some((b) => b?.type === 'tool_result'), 'no tool_result row reached the chat');
  await s.rt.stop(s.handle, 'kill');
});

test('slash-command output reaches the chat', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say OK', []);
  await s.settle();
  const before = s.items.length;

  await s.rt.submit(s.handle, '/context', []);
  await s.settle(60_000);

  const added = s.items.slice(before);
  assert.ok(added.length > 0, 'the slash command produced no row at all');
  const body = JSON.stringify(added);
  assert.match(body, /Context Usage|Tokens/i);
  await s.rt.stop(s.handle, 'kill');
});

// A locally-answered command emits an assistant message whose usage is all
// zeros. Reading it would blank the context bar of a session that is 20k deep.
test('a slash command does not blank the context bar', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say OK', []);
  await s.settle();
  const real = await s.rt.usage(s.handle);
  assert.ok((real?.contextTokens ?? 0) > 1000, `context looked empty: ${real?.contextTokens}`);

  await s.rt.submit(s.handle, '/context', []);
  await s.settle(60_000);

  const after = await s.rt.usage(s.handle);
  assert.ok(
    (after?.contextTokens ?? 0) >= (real?.contextTokens ?? 0),
    `context went backwards after a local command: ${real?.contextTokens} → ${after?.contextTokens}`,
  );
  await s.rt.stop(s.handle, 'kill');
});

test('an attached image is understood without a Read round-trip', async () => {
  // A 64x64 PNG that is solid red, built with sips so the bytes are a real image.
  const png = path.join(AGENT_DIR, 'red.png');
  const { execFileSync } = await import('node:child_process');
  execFileSync('/bin/sh', ['-c',
    `printf 'P3\\n1 1\\n255\\n255 0 0\\n' > ${AGENT_DIR}/red.ppm && ` +
    `sips -s format png -z 64 64 ${AGENT_DIR}/red.ppm --out ${png} >/dev/null 2>&1`,
  ]);
  assert.ok(fs.existsSync(png), 'could not build the test image');

  const s = await open();
  const from = s.items.length;
  assert.equal(await s.rt.submit(s.handle, 'What colour fills this image? One word.', [
    { path: png, mediaType: 'image/png' },
  ]), true);
  await s.settle();

  assert.match(textOf(s.items.slice(from)), /red/i);
  // The bytes were in the request, so nothing had to Read the file.
  const blocks = s.items.flatMap((i) => (Array.isArray(i.content) ? i.content : [])) as any[];
  assert.ok(
    !blocks.some((b) => b?.type === 'tool_use' && b?.name === 'Read'),
    'the model had to Read the image — it was not inlined',
  );
  await s.rt.stop(s.handle, 'kill');
});

// ── usage accounting ────────────────────────────────────────────────────────

test('usage reports a live context reading and a growing session total', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say A', []);
  await s.settle();
  const first = await s.rt.usage(s.handle);
  assert.ok(first, 'no usage for a live session');
  assert.ok(first!.contextTokens! > 1000, `context bar would read ${first!.contextTokens}`);
  assert.ok(first!.totalTokens > 0);

  await s.rt.submit(s.handle, 'Say B', []);
  await s.settle();
  const second = await s.rt.usage(s.handle);
  // The session total is cumulative; the context reading is not — it is
  // occupancy, which is why it must not be a sum.
  assert.ok(second!.totalTokens > first!.totalTokens, 'the session total did not accumulate');
  assert.ok(second!.contextTokens! < second!.totalTokens, 'context looks like a running sum');
  assert.ok((second!.costUsd ?? 0) >= (first!.costUsd ?? 0));

  await s.rt.stop(s.handle, 'kill');
});

test('a hibernated session still reports its context from the transcript', async () => {
  const s = await open();
  await s.rt.submit(s.handle, 'Say OK', []);
  await s.settle();
  const live = await s.rt.usage(s.handle);
  await s.rt.stop(s.handle, 'hibernate');

  // No live handle now: the context bar has to come off disk, or a sleeping
  // session renders blank.
  assert.equal(await s.rt.usage(s.handle), null);
  const stored = await s.rt.storedUsage!(s.handle);
  assert.ok(stored, 'a hibernated session lost its context reading');
  assert.equal(stored!.contextTokens, live!.contextTokens);
});

// ── what the session is doing, not just whether ─────────────────────────────

test('a running tool is reported by name, with how long it has been running', async () => {
  const s = await open();
  // python3, not `sleep`: Claude Code moves a foreground `sleep` to the
  // background on its own, which is a different (also correct) answer and would
  // not exercise the foreground path.
  assert.equal(await s.rt.submit(
    s.handle,
    'Run exactly this with the Bash tool: `python3 -c "import time; time.sleep(20)"` . Then say FINISHED.',
    [],
  ), true);

  let seen: any = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const a: any = await (s.rt as any).activity(s.handle);
    if (a?.kind === 'tool') { seen = a; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(seen, 'the session never said what it was doing');
  console.log(`      ↳ reported: ${JSON.stringify(seen)}`);
  assert.equal(seen.label, 'Bash');
  assert.match(String(seen.detail ?? ''), /time\.sleep/);
  assert.ok(typeof seen.elapsedSec === 'number' && seen.elapsedSec >= 0);

  await s.settle(240_000);
  // Idle again → nothing to report. A chip that outlives the thing it describes
  // is worse than no chip.
  assert.equal(await (s.rt as any).activity(s.handle), null, 'activity did not clear when the turn ended');
  await s.rt.stop(s.handle, 'kill');
});

// Background work OUTLIVES the turn that started it, so it must keep being
// reported after the turn ends — and must clear itself when it finishes, which
// it can only do because the CLI announces completion with an empty task list
// (measured: `background_tasks_changed → 0 tasks` plus a task_notification).
test('background work is reported past the end of its turn, then clears', async () => {
  const s = await open();
  assert.equal(await s.rt.submit(
    s.handle,
    'Run `sleep 8` with the Bash tool in the background, then say STARTED. Do not wait for it.',
    [],
  ), true);
  await s.settle(120_000);

  const during: any = await (s.rt as any).activity(s.handle);
  assert.ok(during, 'a live background task was reported as nothing at all');
  assert.ok((during.backgroundCount ?? 0) > 0, `expected a background count: ${JSON.stringify(during)}`);
  console.log(`      ↳ after the turn: ${JSON.stringify(during)}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if ((await (s.rt as any).activity(s.handle)) === null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(await (s.rt as any).activity(s.handle), null, 'the background chip never cleared');
  await s.rt.stop(s.handle, 'kill');
});

test('a closed session reports no activity at all', async () => {
  const s = await open();
  await s.rt.stop(s.handle, 'kill');
  assert.equal(await (s.rt as any).activity(s.handle), null);
});

// ── the long-Bash watchdog ──────────────────────────────────────────────────

// The case the pane could not handle: a command that outlives the turn's
// patience. Escape killed everything; this moves the command aside and lets the
// turn carry on.
test('a Bash that outlives the threshold is backgrounded, and the session survives', async () => {
  const prevAfter = process.env.HERMIT_BASH_BACKGROUND_AFTER_MS;
  const prevTick = process.env.HERMIT_BASH_WATCHDOG_TICK_MS;
  process.env.HERMIT_BASH_BACKGROUND_AFTER_MS = '8000';
  process.env.HERMIT_BASH_WATCHDOG_TICK_MS = '1000';
  try {
    const s = await open();
    const from = s.items.length;
    // python3, not `sleep`: Claude Code backgrounds a foreground `sleep` itself,
    // so it would never reach the watchdog.
    assert.equal(await s.rt.submit(
      s.handle,
      'Use the Bash tool to run exactly `python3 -c "import time; time.sleep(90)"` and nothing else first. ' +
      'Do not run any other command before it.',
      [],
    ), true);

    // Wait for the watchdog's own banner rather than for the model to phrase
    // something a particular way — the banner is what this test is about, and
    // the model's wording is not ours to assert on.
    const t0 = Date.now();
    let rescued = false;
    while (Date.now() - t0 < 180_000) {
      if (JSON.stringify(s.items.slice(from)).includes('转入后台')) { rescued = true; break; }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    assert.ok(rescued, 'the watchdog never moved the command');
    console.log(`      ↳ rescued after ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    // "The turn survives" means the session is still usable — not that the model
    // said any particular word. That is the property worth holding.
    await s.settle(240_000);
    assert.match(await s.turn('Say ALIVE'), /ALIVE/i, 'the session was unusable after the rescue');
    await s.rt.stop(s.handle, 'kill');
  } finally {
    if (prevAfter === undefined) delete process.env.HERMIT_BASH_BACKGROUND_AFTER_MS;
    else process.env.HERMIT_BASH_BACKGROUND_AFTER_MS = prevAfter;
    if (prevTick === undefined) delete process.env.HERMIT_BASH_WATCHDOG_TICK_MS;
    else process.env.HERMIT_BASH_WATCHDOG_TICK_MS = prevTick;
  }
});

// A known-long command should not have to wait for the watchdog at all.
test('a known-long command starts in the background', async () => {
  const s = await open();
  const from = s.items.length;
  // `npm ci` in a directory with no package.json fails fast — what is asserted
  // is WHERE it ran, not that it succeeded.
  assert.equal(await s.rt.submit(
    s.handle,
    'Use the Bash tool to run exactly `npm ci` and tell me what happened. Run no other command first.',
    [],
  ), true);
  await s.settle(180_000);

  // Find the npm call among however many the model made — it is free to look
  // around first, and the assertion is about the one command that matters.
  const blocks = s.items.slice(from).flatMap((i) => (Array.isArray(i.content) ? i.content : [])) as any[];
  const npmCall = blocks.find((b) => b?.type === 'tool_use' && b?.name === 'Bash' && /npm ci/.test(String(b?.input?.command ?? '')));
  assert.ok(npmCall, 'the model never ran npm ci');
  const npmResult = blocks.find((b) => b?.type === 'tool_result' && b?.tool_use_id === npmCall.id);
  assert.ok(npmResult, 'no result for the npm call');
  console.log(`      ↳ npm ci result: ${JSON.stringify(String(npmResult.content).slice(0, 80))}`);
  assert.match(
    String(npmResult.content ?? ''),
    /background/i,
    'the hook did not move a known-long command to the background',
  );
  await s.rt.stop(s.handle, 'kill');
});
