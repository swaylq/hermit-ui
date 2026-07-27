import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryPage, type CachedRow } from './summary-page';

const row = (id: string, createdAt: string, text: string, extra: Partial<CachedRow> = {}): CachedRow => ({
  id, createdAt, role: 'assistant', text, ...extra,
});

// Deliberately out of order — the cache hands back whatever the index yields.
const CORPUS: CachedRow[] = [
  row('c', '2026-07-01T00:00:03.000Z', 'three'),
  row('a', '2026-07-01T00:00:01.000Z', 'one'),
  row('e', '2026-07-01T00:00:05.000Z', 'five'),
  row('b', '2026-07-01T00:00:02.000Z', 'two'),
  row('d', '2026-07-01T00:00:04.000Z', 'four'),
];

test('a page is the newest rows before the edge, oldest first', () => {
  const { rows, hasMore } = summaryPage(CORPUS, { createdAt: '2026-07-01T00:00:05.000Z', id: 'e' }, 2);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'd']);
  assert.equal(hasMore, true);
});

test('paging walks backwards without gaps or repeats', () => {
  const seen: string[] = [];
  let edge = { createdAt: '2026-07-01T00:00:05.000Z', id: 'e' };
  for (;;) {
    const { rows, hasMore } = summaryPage(CORPUS, edge, 2);
    if (rows.length === 0) break;
    seen.unshift(...rows.map((r) => r.id));
    if (!hasMore) break;
    edge = { createdAt: rows[0].createdAt, id: rows[0].id };
  }
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
});

test('hasMore is false once the beginning is reached', () => {
  const { rows, hasMore } = summaryPage(CORPUS, { createdAt: '2026-07-01T00:00:03.000Z', id: 'c' }, 10);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
  assert.equal(hasMore, false);
});

test('no edge means the newest page', () => {
  const { rows } = summaryPage(CORPUS, null, 2);
  assert.deepEqual(rows.map((r) => r.id), ['d', 'e']);
});

// The row the timeline currently starts at is usually a tool result, which has
// no prose and so is absent from this cache. Positioning must not depend on
// finding it.
test('an edge that is not in the cache still positions correctly', () => {
  const { rows } = summaryPage(CORPUS, { createdAt: '2026-07-01T00:00:03.500Z', id: 'zzz-tool-row' }, 10);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']);
});

test('same timestamp falls back to id order', () => {
  const same: CachedRow[] = [
    row('m2', '2026-07-01T00:00:01.000Z', 'second'),
    row('m1', '2026-07-01T00:00:01.000Z', 'first'),
    row('m3', '2026-07-01T00:00:01.000Z', 'third'),
  ];
  const { rows } = summaryPage(same, { createdAt: '2026-07-01T00:00:01.000Z', id: 'm3' }, 10);
  assert.deepEqual(rows.map((r) => r.id), ['m1', 'm2']);
});

test('the harness terminator is dropped, exactly as the timeline drops it', () => {
  const withTerm = [...CORPUS, row('t', '2026-07-01T00:00:06.000Z', 'No response requested.')];
  const { rows } = summaryPage(withTerm, null, 10);
  assert.equal(rows.some((r) => r.id === 't'), false);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
});

test('empty prose is not a row', () => {
  const { rows } = summaryPage([row('x', '2026-07-01T00:00:01.000Z', '   ')], null, 10);
  assert.deepEqual(rows, []);
});

test('prose becomes a text block', () => {
  const { rows } = summaryPage([row('a', '2026-07-01T00:00:01.000Z', 'hello')], null, 10);
  assert.deepEqual(rows[0].content, [{ type: 'text', text: 'hello' }]);
});

// Interaction cards carry no prose, so without this they would silently vanish
// from cache-served history — measured at 0–6 per session, and they are exactly
// the rows a reader notices missing (a question they were asked and answered).
test('interaction cards survive with their blocks intact', () => {
  const card = [{ type: 'interaction', kind: 'question', status: 'resolved', payload: { options: [] } }];
  const { rows } = summaryPage(
    [row('i', '2026-07-01T00:00:01.000Z', '', { role: 'system', blocks: card })],
    null,
    10
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].content, card);
  assert.equal(rows[0].role, 'system');
});

test('a page never exceeds its size', () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    row(`m${String(i).padStart(3, '0')}`, `2026-07-01T00:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}.000Z`, `msg ${i}`)
  );
  const { rows, hasMore } = summaryPage(many, null, 40);
  assert.equal(rows.length, 40);
  assert.equal(hasMore, true);
  assert.equal(rows[rows.length - 1].id, 'm099');
});
