import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readLfLines } from './lf-lines';

// Built, never typed as literals — see the note in lf-lines.ts.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
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

test('the separators readline breaks on stay inside the line', () => {
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
