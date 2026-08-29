import assert from 'node:assert/strict';
import test from 'node:test';
import { capMessageContent, dropStoredImageBytes } from './message-cap';
import { digestMessageContent } from './message-digest';

type Blk = Record<string, unknown>;
const cap = (content: unknown[]): Blk[] => capMessageContent(content) as Blk[];
const big = (n: number) => 'x'.repeat(n);

// A real signature is ~4 KB of base64; the length is what matters here, not the
// alphabet.
const SIG = 'ErwECmMIDhgCKkBG' + big(4_000);

// ── the signature strip (the 401 MB) ────────────────────────────────────────

test('a thinking block loses its signature and keeps everything else', () => {
  const [d] = cap([{ type: 'thinking', thinking: 'reasoning', signature: SIG }]);
  assert.deepEqual(d, { type: 'thinking', thinking: 'reasoning' });
});

test('a thinking block with no signature comes back by reference', () => {
  const block = { type: 'thinking', thinking: 'reasoning' };
  const content = [block];
  assert.equal(capMessageContent(content), content);
});

test('the 94% shape — empty body, huge signature — collapses to almost nothing', () => {
  const before = JSON.stringify([{ type: 'thinking', thinking: '', signature: SIG }]).length;
  const after = JSON.stringify(capMessageContent([{ type: 'thinking', thinking: '', signature: SIG }])).length;
  assert.ok(after < before / 50, `expected >50x shrink, got ${before} → ${after}`);
});

test('capping first is what lets the digest leave an empty thinking block alone', () => {
  // The regression this pair exists for: digestMessageContent returns an empty
  // thinking block by reference, so while the signature was still attached the
  // digest shipped all 401 MB of it. Order matters — cap, then digest.
  const raw = [{ type: 'thinking', thinking: '', signature: SIG }];
  const digestedRaw = JSON.stringify(digestMessageContent(raw)).length;
  const digestedCapped = JSON.stringify(digestMessageContent(capMessageContent(raw))).length;
  assert.ok(digestedRaw > 4_000, 'digest alone cannot drop a signature');
  assert.ok(digestedCapped < 60, `cap+digest should be tiny, got ${digestedCapped}`);
});

test('a signature nested inside a tool_result is dropped too', () => {
  const [d] = cap([
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'thinking', thinking: '', signature: SIG }] },
  ]);
  assert.deepEqual(d.content, [{ type: 'thinking', thinking: '' }]);
});

test('the write path drops the signature as well, so it is never stored', () => {
  const stored = dropStoredImageBytes([{ type: 'thinking', thinking: 'r', signature: SIG }]) as Blk[];
  assert.deepEqual(stored[0], { type: 'thinking', thinking: 'r' });
  const untouched = [{ type: 'thinking', thinking: 'r' }];
  assert.equal(dropStoredImageBytes(untouched), untouched);
});

// ── the behaviours that were already there and must not move ────────────────

test('a long text block is truncated with the note, a short one is not', () => {
  const [d] = cap([{ type: 'text', text: big(20_000) }]);
  assert.ok(String(d.text).startsWith(big(12_000)));
  assert.ok(String(d.text).includes('内容过长'));
  const short = [{ type: 'text', text: 'hi' }];
  assert.equal(capMessageContent(short), short);
});

test('base64 inside a tool_result is elided; a top-level image is left alone', () => {
  const [d] = cap([
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', data: big(200_000) } }] },
  ]);
  const src = (d.content as Blk[])[0].source as Blk;
  assert.equal(src.data, '');
  assert.equal(src.elidedKB, 195);

  const attachment = [{ type: 'image', source: { type: 'base64', data: big(200_000) } }];
  assert.equal(capMessageContent(attachment), attachment, 'a user attachment IS rendered');
});

test('a non-array content column is returned unchanged', () => {
  assert.equal(capMessageContent(null), null);
  assert.equal(capMessageContent('plain'), 'plain');
});
