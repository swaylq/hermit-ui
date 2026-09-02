// Integration tests for the session host — a REAL Claude Code, a real host
// process's socket, no mocks.
//
// These are the only tests that can answer the question the whole layer exists
// for, and none of it can be checked by reading code: whether a claude child
// genuinely outlives the process that asked for it, whether a second gateway
// gets the SAME warm process rather than a resumed transcript, and whether a
// turn in flight keeps running while nobody is attached.
//
// Run with `npm run test:integration`. They spend real tokens and real seconds.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSdkRuntime, shutdownClaudeSdk } from './claude-sdk';
import { startSessionHost, type SessionHost } from '../session-host/host';
import { hostSessions, hostKill } from './session-host-client';
import type { RuntimeHandle, SyncItem } from './types';

let host: SessionHost;
let AGENT_DIR = '';
let seq = 0;

before(async () => {
  AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-host-it-'));
  fs.writeFileSync(path.join(AGENT_DIR, 'CLAUDE.md'), '# host-probe\n\nAnswer in one short line.\n');
  const sock = path.join(AGENT_DIR, 'host.sock');
  process.env.HERMIT_HOST_SOCK = sock;
  process.env.HERMIT_SESSION_HOST = '1';
  host = await startSessionHost({ socketPath: sock, log: () => {}, sweepMs: 3_600_000 });
});

after(async () => {
  shutdownClaudeSdk();
  await host?.close();
  delete process.env.HERMIT_SESSION_HOST;
  delete process.env.HERMIT_HOST_SOCK;
  try { fs.rmSync(AGENT_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

interface Session {
  rt: ClaudeSdkRuntime;
  handle: RuntimeHandle;
  items: SyncItem[];
  turn: (text: string, ms?: number) => Promise<string>;
}

const isLive = (i: SyncItem) => i.externalId.startsWith('sdk-live-');
const textOf = (items: SyncItem[]) =>
  items
    .filter((i) => i.role === 'assistant' && !isLive(i))
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

/** A fresh ClaudeSdkRuntime is the shape of a gateway that just started. */
async function open(sessionId: string, externalSessionId: string | null = null): Promise<Session> {
  const rt = new ClaudeSdkRuntime();
  const items: SyncItem[] = [];
  const handle = await rt.ensure(
    { id: sessionId, agentName: 'host-probe', agentDirectory: AGENT_DIR, externalSessionId },
    (i) => items.push(i),
  );
  const turn = async (text: string, ms = 180_000) => {
    const from = items.length;
    assert.equal(await rt.submit(handle, text, []), true, 'submit was refused');
    const t0 = Date.now();
    for (;;) {
      const said = items.slice(from).some((i) => i.role === 'assistant' && !isLive(i));
      if (said && !(await rt.isWorking(handle))) break;
      if (Date.now() - t0 > ms) throw new Error(`turn did not complete in ${ms}ms`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 300));
    return textOf(items.slice(from));
  };
  return { rt, handle, items, turn };
}

test('the child belongs to the host, not to us', async () => {
  const id = `host-it-${Date.now()}-${seq++}`;
  const s = await open(id);
  assert.match(await s.turn('Say ALIVE and nothing else.'), /ALIVE/);

  const held = await hostSessions();
  assert.ok(held, 'the host did not answer');
  assert.equal(held!.filter((h) => h.sessionId === id).length, 1, 'the host is not holding this session');
  assert.equal(held!.find((h) => h.sessionId === id)!.attached, true);

  await hostKill(id);
  shutdownClaudeSdk();
});

test('a gateway that goes away leaves the child running, and the next one adopts it', async () => {
  const id = `host-it-${Date.now()}-${seq++}`;
  const first = await open(id);
  await first.turn('Remember this number: 31415. Reply "stored".');
  const uuid = first.handle.externalSessionId;
  const pidBefore = (await hostSessions())!.find((h) => h.sessionId === id)!.pid;

  // What the shutdown drain does now: let go, do not end.
  await first.rt.detach!(first.handle);
  await new Promise((r) => setTimeout(r, 1_000));

  const stillThere = (await hostSessions())!.find((h) => h.sessionId === id);
  assert.ok(stillThere, 'the child died with the gateway — the whole point is that it does not');
  assert.equal(stillThere!.pid, pidBefore, 'the child was replaced rather than kept');
  assert.equal(stillThere!.attached, false, 'the host still thinks a dead gateway is attached');

  // A fresh runtime instance with empty module state: the next gateway.
  const t0 = Date.now();
  const second = await open(id, uuid);
  const recalled = await second.turn('What number did I ask you to remember? Digits only.');
  const adoptMs = Date.now() - t0;

  assert.match(recalled, /31415/, 'the conversation did not survive the restart');
  assert.equal((await hostSessions())!.find((h) => h.sessionId === id)!.pid, pidBefore,
    'the second gateway started a new child instead of adopting the live one');
  console.log(`      ↳ adopt + answer: ${adoptMs}ms (a resume from transcript is ~3s+)`);

  await hostKill(id);
  shutdownClaudeSdk();
});

test('a turn in flight keeps running while no gateway is attached', async () => {
  const id = `host-it-${Date.now()}-${seq++}`;
  const s = await open(id);
  const sentinel = path.join(AGENT_DIR, `go-${seq}`);

  // Foreground and genuinely blocking. A bare `sleep` is refused by this
  // harness and the model reruns it in the background, which is not a turn in
  // flight at all — measured the hard way while writing the Layer 0 tests.
  assert.equal(await s.rt.submit(s.handle,
    `Run exactly this with the Bash tool, in the foreground (do NOT pass run_in_background): ` +
    `until [ -f ${sentinel} ]; do sleep 1; done. Then say EXACTLY: SURVIVED-31415`, []), true);
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000 && !(await s.rt.isWorking(s.handle))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await s.rt.isWorking(s.handle), true, 'the turn never started');
  await new Promise((r) => setTimeout(r, 3_000));

  // The gateway goes away MID-TURN.
  await s.rt.detach!(s.handle);
  await new Promise((r) => setTimeout(r, 1_000));
  assert.ok((await hostSessions())!.some((h) => h.sessionId === id), 'the mid-turn child died with the gateway');

  // Reattach WHILE the turn is still blocked. This is the question the message
  // queue depends on: a fresh handle has pending=0, statusBusy=false and no
  // session state, and all three are only ever set by an inbound frame — so if
  // the CLI says nothing until the turn ends, the gateway reads a busy session
  // as idle and `deliverMessages` will push a queued message straight into it.
  const next = await open(id, s.handle.externalSessionId);
  const tw = Date.now();
  let becameBusy = false;
  while (Date.now() - tw < 20_000) {
    if (await next.rt.isWorking(next.handle)) { becameBusy = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`      ↳ reattached mid-turn: isWorking became true after ${becameBusy ? Date.now() - tw : '>20000'}ms`);
  assert.equal(becameBusy, true,
    'a reattached session mid-tool-call never reads as working — the one-message-per-turn gate stays open');

  // …and now the thing it was waiting for happens.
  fs.writeFileSync(sentinel, '');
  const t1 = Date.now();
  while (Date.now() - t1 < 60_000 && !JSON.stringify(next.items).includes('SURVIVED-31415')) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(JSON.stringify(next.items), /SURVIVED-31415/,
    'the turn that ran across the gap never reached the conversation');

  await hostKill(id);
  shutdownClaudeSdk();
});
