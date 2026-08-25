import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime, needsStoredUsage, readTailBytes, tailLines } from './session-snapshot';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, RuntimeUsage } from '../runtime/types';

function fakeRuntime(live: RuntimeUsage | null, stored: RuntimeUsage | null): AgentRuntime {
  return {
    kind: 'codex-exec',
    async ensure() { throw new Error('not used'); },
    async submit() { return false; },
    async isWorking() { return false; },
    // Held-ness is a separate question from busy-ness; this fake is a session
    // with no child at all, which is what makes storedUsage the thing under test.
    async isLive() { return false; },
    async interrupt() {},
    async compact() {},
    async usage() { return live; },
    async storedUsage() { return stored; },
    async stop() {},
  };
}

const stored: RuntimeUsage = {
  contextTokens: 26_630,
  outputTokens: 512,
  totalTokens: 12_173_126,
  costUsd: null,
};

test('durable usage repairs tokens without waking an offline session', async () => {
  const snapshot = await probeRuntime(
    fakeRuntime(null, stored),
    'session-id',
    'agent',
    '/tmp/agent-dir',
    'codex-thread-id',
  );
  assert.equal(snapshot.contextTokens, 26_630);
  assert.equal(snapshot.outputTokens, 512);
  assert.equal(snapshot.alive, false);
  assert.equal(snapshot.state, null);
});

test('live usage still marks an idle runtime handle alive', async () => {
  const snapshot = await probeRuntime(
    fakeRuntime(stored, null),
    'session-id',
    'agent',
    '/tmp/agent-dir',
    'codex-thread-id',
  );
  assert.equal(snapshot.contextTokens, 26_630);
  assert.equal(snapshot.alive, true);
  assert.equal(snapshot.state, 'idle');
});

// ── needsStoredUsage ────────────────────────────────────────────────────────
// The gate that keeps an 8-second tick off the filesystem. It must be false in
// the common case (the transcript tail already carried the usage record) and
// true in every case where skipping it would blank a context bar that used to
// render — the snapshot has to stay byte-identical to the unconditional version.

const both = (c: number | null, o: number | null) => ({ contextTokens: c, outputTokens: o });

test('a live session never reads the disk fallback — its handle outranks it', () => {
  assert.equal(needsStoredUsage(true, both(null, null), null), false);
  assert.equal(needsStoredUsage(true, both(null, null), both(null, null)), false);
});

test('the common case: the tail already answered, so nothing is read', () => {
  assert.equal(needsStoredUsage(false, both(24_000, 700), null), false);
});

test('the runtime answering is enough too, even with an empty tail', () => {
  assert.equal(needsStoredUsage(false, both(null, null), both(24_000, 700)), false);
});

test('nothing in hand: the fallback fires, which is what it is for', () => {
  assert.equal(needsStoredUsage(false, both(null, null), null), true);
  assert.equal(needsStoredUsage(false, both(null, null), both(null, null)), true);
});

// They come off one transcript event, so they move together — but the gate asks
// about each rather than assuming, so a half-answer still reaches the fallback
// instead of silently dropping the missing half.
test('half an answer still reads the fallback', () => {
  assert.equal(needsStoredUsage(false, both(24_000, null), null), true);
  assert.equal(needsStoredUsage(false, both(null, 700), null), true);
  assert.equal(needsStoredUsage(false, both(24_000, null), both(null, 700)), false);
});

// Zero is a measurement, not a missing value: a session whose window really is
// empty must not send the collector back to the disk on every tick.
test('zero is an answer, not an absence', () => {
  assert.equal(needsStoredUsage(false, both(0, 0), null), false);
});

// ── Reading the end of a transcript ─────────────────────────────────────────
// This was a `tail` child process per session per 8-second tick — 12 running at
// the same instant on a live gateway, ~130,000 spawns a day, feeding the same fd
// pressure run() carries a synchronous-throw guard for. Node can open a file.

function tmpFile(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-bytes-'));
  const p = path.join(dir, 'x.jsonl');
  fs.writeFileSync(p, body);
  return p;
}

test('a file smaller than the window comes back whole', async () => {
  const got = await readTailBytes(tmpFile('abc\ndef\n'), 1024);
  assert.deepEqual(got, { text: 'abc\ndef\n', whole: true });
});

test('a window smaller than the file returns exactly its last bytes', async () => {
  const got = await readTailBytes(tmpFile('0123456789'), 4);
  assert.equal(got?.text, '6789');
  assert.equal(got?.whole, false, 'the caller has to know its first line may be cut');
});

test('an empty file is not a failure', async () => {
  assert.deepEqual(await readTailBytes(tmpFile(''), 1024), { text: '', whole: true });
});

test('a file that is not there reads null, not an empty one', async () => {
  assert.equal(await readTailBytes(path.join(os.tmpdir(), 'no-such-transcript.jsonl'), 1024), null);
});

test('tailLines hands back the newest n, in order', async () => {
  const p = tmpFile(Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n') + '\n');
  const lines = await tailLines(p, 3);
  assert.deepEqual(lines, ['line47', 'line48', 'line49']);
});

test('a blank trailing line is not a line', async () => {
  assert.deepEqual(await tailLines(tmpFile('a\nb\n\n\n'), 10), ['a', 'b']);
});

test('a missing transcript is no lines rather than a throw', async () => {
  assert.deepEqual(await tailLines(path.join(os.tmpdir(), 'nope.jsonl'), 10), []);
});

// The one thing a byte window gets wrong if nobody handles it: the line the
// window landed in the middle of. Dropping it is why the scan never sees half
// a JSON record it would have to fail to parse.
test('a huge line beyond the window is dropped, not handed over as a fragment', async () => {
  // The real shape: one enormous tool result, then the lines that matter. A
  // line-bounded tail would read the whole thing to reach them.
  const huge = JSON.stringify({ type: 'user', big: 'x'.repeat(2 * 1024 * 1024) });
  const p = tmpFile([huge, '{"type":"assistant","n":1}', '{"type":"assistant","n":2}'].join('\n') + '\n');
  const lines = await tailLines(p, 500);
  assert.deepEqual(lines, ['{"type":"assistant","n":1}', '{"type":"assistant","n":2}']);
  // Every line handed over parses — no half a record for the scan to choke on.
  for (const l of lines) JSON.parse(l);
});

// And the ceiling that buys: the window, not the file.
test('the read is bounded by the window even when the file is not', async () => {
  const p = tmpFile('y'.repeat(5 * 1024 * 1024));
  const got = await readTailBytes(p, 1024);
  assert.equal(got?.text.length, 1024);
  assert.equal(got?.whole, false);
});
