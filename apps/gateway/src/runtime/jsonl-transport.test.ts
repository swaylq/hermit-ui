// The framing, which is the part that can silently lose a message.
//
// A real child is not needed for any of this: the reader is attached to the
// child's stdout, so a PassThrough stands in for it exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonlTransport } from './jsonl-transport';

/** Reach the private reader without spawning anything. */
function reader(onEvent: (ev: Record<string, unknown>) => void) {
  const stdout = new PassThrough();
  const t = new JsonlTransport({
    cliPath: '/nonexistent', baseArgs: [], cwd: '/tmp', args: [], env: {},
    label: 'test', onEvent, onExit: () => {},
  });
  (t as unknown as { attachReader: (c: unknown) => void }).attachReader({ stdout });
  return stdout;
}

function collect(chunks: string[]): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  const stdout = reader((ev) => seen.push(ev));
  for (const c of chunks) stdout.write(c);
  return seen;
}

// THE regression. `readline` also breaks on U+2028/U+2029, which are perfectly
// legal inside a JSON string — so one of them in any payload (scraped web text,
// a JS bundle echoed into a tool result) split one record into two unparseable
// halves and BOTH were dropped. Both pi and prime document exactly this.
//
// Built at runtime, never typed as literals: the characters in this file's own
// bytes are a landmine for every OTHER naive line reader that opens it. A
// codex-backed session reading this file died on exactly that, twice, on
// 2026-08-28 — see runtime/codex-jsonl-repair.ts.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

test('U+2028 and U+2029 inside a string do not split the record', () => {
  const text = `line one${LINE_SEPARATOR}line two${PARAGRAPH_SEPARATOR}line three`;
  const seen = collect([`${JSON.stringify({ type: 'e', text })}\n`]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, text);
});

test('a record split across many chunks is reassembled once', () => {
  const frame = JSON.stringify({ type: 'e', text: 'x'.repeat(300) });
  const chunks = [];
  for (let i = 0; i < frame.length; i += 7) chunks.push(frame.slice(i, i + 7));
  chunks.push('\n');
  const seen = collect(chunks);
  assert.equal(seen.length, 1);
  assert.equal((seen[0].text as string).length, 300);
});

test('several records in one chunk all arrive, in order', () => {
  const seen = collect([
    `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`,
  ]);
  assert.deepEqual(seen.map((e) => e.n), [1, 2, 3]);
});

// The framing stays LF-only; a trailing CR is tolerated on input because the
// protocol says to accept it.
test('CRLF input is accepted, with the CR stripped', () => {
  const seen = collect([`${JSON.stringify({ n: 1 })}\r\n`]);
  assert.deepEqual(seen.map((e) => e.n), [1]);
});

// A multi-byte character split across a chunk boundary must not be mangled —
// which is what a naive Buffer.toString() per chunk does.
test('a multi-byte character split across chunks survives', () => {
  const frame = Buffer.from(`${JSON.stringify({ type: 'e', text: '你好世界' })}\n`, 'utf8');
  const seen = collect([]);
  void seen;
  const out: Record<string, unknown>[] = [];
  const stdout = reader((ev) => out.push(ev));
  // Split mid-character on purpose.
  stdout.write(frame.subarray(0, 15));
  stdout.write(frame.subarray(15));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '你好世界');
});

// Dropping one bad frame is strictly better than tearing down a live session
// over it — the child is broken about that message, not about the conversation.
test('a malformed frame is dropped and the next one still lands', () => {
  const seen = collect([`{not json\n${JSON.stringify({ n: 2 })}\n`]);
  assert.deepEqual(seen.map((e) => e.n), [2]);
});

test('blank lines are ignored', () => {
  const seen = collect([`\n\n${JSON.stringify({ n: 1 })}\n\n`]);
  assert.deepEqual(seen.map((e) => e.n), [1]);
});

// Responses are correlated by id and must never reach the event handler; an
// unmatched one (its request already timed out) is simply dropped.
test('response frames do not surface as events', () => {
  const seen = collect([
    `${JSON.stringify({ type: 'response', id: 'hermit_1', success: true, data: {} })}\n`,
    `${JSON.stringify({ type: 'agent_start' })}\n`,
  ]);
  assert.deepEqual(seen.map((e) => e.type), ['agent_start']);
});
