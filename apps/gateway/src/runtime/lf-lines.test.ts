import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readLfLines } from './lf-lines';

// Built, never typed as literals — see the note in lf-lines.ts.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
/** Not a separator anywhere; here to prove the reader does not touch it. */
const NEL = String.fromCharCode(0x85);

/**
 * The reader only ever listens for 'data' and 'end', so a bare emitter is the
 * whole contract — and it delivers synchronously, which keeps the assertions
 * flat instead of racing a real stream's ticks.
 */
function collect(chunks: Array<string | Buffer>, opts = {}): string[] {
  const seen: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
  readLfLines(stream, (line) => seen.push(line), opts);
  for (const c of chunks) stream.emit('data', c);
  stream.emit('end');
  return seen;
}

test('the two separators readline breaks on stay inside the line', () => {
  const payload = `a${LS}b${PS}c${NEL}d`;
  assert.deepEqual(collect([`${payload}\n`]), [payload], 'not one character lost, not one line split');
});

test('a record split across chunk boundaries is reassembled once', () => {
  const line = 'x'.repeat(300);
  const chunks = [];
  for (let i = 0; i < line.length; i += 7) chunks.push(line.slice(i, i + 7));
  chunks.push('\n');
  assert.deepEqual(collect(chunks), [line]);
});

test('a multi-byte character split across chunks survives', () => {
  const utf8 = Buffer.from('héllo 世界\n', 'utf8');
  assert.deepEqual(collect([utf8.subarray(0, 3), utf8.subarray(3)]), ['héllo 世界']);
});

test('several lines in one chunk arrive in order', () => {
  assert.deepEqual(collect(['a\nb\nc\n']), ['a', 'b', 'c']);
});

test('a trailing CR is stripped, an inner one is not', () => {
  assert.deepEqual(collect(['a\r\nb\rc\n']), ['a', 'b\rc']);
});

test('a stream that ends without a newline still delivers its last line', () => {
  assert.deepEqual(collect(['done\nlast']), ['done', 'last'], 'readline parity: no silent loss at exit');
});

test('an empty tail is not delivered as a blank line', () => {
  assert.deepEqual(collect(['a\n']), ['a']);
});

test('a runaway line is dropped, is reported, and does not take the next one with it', () => {
  const oversize: number[] = [];
  const seen = collect(
    ['y'.repeat(50), '\n', 'after\n'],
    { maxLineChars: 10, onOversize: (n: number) => oversize.push(n) },
  );
  assert.deepEqual(seen, ['after']);
  assert.equal(oversize.length, 1);
});

// The emitter above proves the splitting; these two prove the plumbing. Both
// call sites that moved off `readline` read a real child — kimi its stdout, dsh
// its fd 3 — and the questions that decide whether they still work are whether
// attaching 'data' puts the stream in flowing mode at all, and whether the last
// line arrives when the child exits without a trailing newline.
function fromChild(argv: string, fd: 1 | 3): Promise<string[]> {
  const stdio = fd === 1
    ? ['ignore', 'pipe', 'ignore'] as const
    : ['ignore', 'ignore', 'ignore', 'pipe'] as const;
  const child = spawn('/bin/sh', ['-c', argv], { stdio: [...stdio] });
  const stream = (fd === 1 ? child.stdout : child.stdio[3]) as NodeJS.ReadableStream;
  const seen: string[] = [];
  readLfLines(stream, (line) => seen.push(line));
  return new Promise((resolve) => child.on('close', () => setImmediate(() => resolve(seen))));
}

test("a real child's stdout delivers every line, including a last one with no newline", async () => {
  assert.deepEqual(await fromChild('printf "one\\ntwo"', 1), ['one', 'two']);
});

test("a real child's fd 3 delivers every line — dsh's event channel", async () => {
  assert.deepEqual(await fromChild('printf "a\\nb\\n" >&3', 3), ['a', 'b']);
});
