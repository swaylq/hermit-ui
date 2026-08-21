import assert from 'node:assert/strict';
import test from 'node:test';
import { digestMessageContent, DIGEST_FLAG } from './message-digest';

type Blk = Record<string, unknown>;
const digest = (content: unknown[]): Blk[] => digestMessageContent(content) as Blk[];

const big = (n: number) => 'x'.repeat(n);

test('prose, images, files and interaction cards pass through by reference', () => {
  const content = [
    { type: 'text', text: 'hello' },
    { type: 'image', source: { type: 'url', url: '/uploads/a.png' } },
    { type: 'file', name: 'r.pdf', source: { type: 'url', url: '/uploads/r.pdf' } },
    { type: 'interaction', kind: 'question', payload: { question: 'q' }, status: 'pending' },
  ];
  assert.equal(digestMessageContent(content), content);
});

test('a big tool_use keeps the name and the argument the chip shows', () => {
  const [d] = digest([
    { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a/b/c.ts', content: big(50_000) } },
  ]);
  assert.equal(d.name, 'Write');
  assert.equal(d.id, 't1');
  assert.deepEqual(d.input, { file_path: '/a/b/c.ts' });
  assert.equal(d[DIGEST_FLAG], 1);
});

test('a small tool_use is left whole — nothing to fetch on expand', () => {
  const block = { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } };
  const [d] = digest([block]);
  assert.equal(d, block);
});

test('a big tool_result keeps its first line and its error flag', () => {
  const [d] = digest([
    { type: 'tool_result', tool_use_id: 't1', is_error: true, content: `boom: it failed\n${big(30_000)}` },
  ]);
  assert.equal(d.is_error, true);
  assert.equal(d.tool_use_id, 't1');
  assert.equal(d.content, 'boom: it failed ' + big(163) + '…');
  assert.ok(String(d.content).length <= 180);
});

test('a block-array tool_result digests to its first text block', () => {
  const [d] = digest([
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: {} }, { type: 'text', text: `first line\n${big(9_000)}` }] },
  ]);
  assert.ok(String(d.content).startsWith('first line'));
  assert.equal(d[DIGEST_FLAG], 1);
});

test('thinking always loses its body but keeps its length', () => {
  const [d] = digest([{ type: 'thinking', thinking: big(4_200) }]);
  assert.deepEqual(d, { type: 'thinking', thinking: '', chars: 4200, [DIGEST_FLAG]: 1 });
});

test('an empty thinking block is untouched', () => {
  const block = { type: 'thinking', thinking: '' };
  const [d] = digest([block]);
  assert.equal(d, block);
});

test('digesting is a big win on a realistic turn', () => {
  const raw = [
    { type: 'thinking', thinking: big(6_000) },
    { type: 'text', text: '我先读一下这个文件' },
    { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a.ts', content: big(20_000) } },
  ];
  const before = JSON.stringify(raw).length;
  const after = JSON.stringify(digestMessageContent(raw)).length;
  assert.ok(after < before / 50, `expected >50x shrink, got ${before} → ${after}`);
  // The prose survives verbatim — that is the whole point.
  assert.equal(digest(raw)[1].text, '我先读一下这个文件');
});

test('a non-array content column is returned unchanged', () => {
  assert.equal(digestMessageContent('plain'), 'plain');
  assert.equal(digestMessageContent(null), null);
});
