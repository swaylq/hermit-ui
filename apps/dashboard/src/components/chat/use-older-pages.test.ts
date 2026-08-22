import test from 'node:test';
import assert from 'node:assert/strict';
import { pageBefore, chunksBottomFirst, OLDER_PAGE, COMMIT_CHUNK, allBefore } from './use-older-pages';

// The seam between a cached page and the rest of history. Getting it wrong does
// not throw — it shows a turn twice, or drops one, the next time someone reads
// back through a conversation they have already read.

const row = (id: string, createdAt: string) => ({ id, createdAt });

// (createdAt, id) is the total order the server pages by. Ties on the timestamp
// are real: a turn's rows land in the same millisecond often enough that
// ordering by time alone loops forever on the same page.
const HISTORY = [
  row('a', '2026-08-21T10:00:00.000Z'),
  row('b', '2026-08-21T10:00:01.000Z'),
  row('c', '2026-08-21T10:00:02.000Z'),
  row('d', '2026-08-21T10:00:02.000Z'), // same ms as c
  row('e', '2026-08-21T10:00:03.000Z'),
];

test('a whole page comes back, newest-last', () => {
  const page = pageBefore(HISTORY, { createdAt: '2026-08-21T10:00:03.000Z', id: 'e' }, 2);
  assert.deepEqual(page?.map((r) => r.id), ['c', 'd']);
});

test('the edge row itself is never included — that is the duplicate', () => {
  const page = pageBefore(HISTORY, { createdAt: '2026-08-21T10:00:02.000Z', id: 'd' }, 3);
  assert.deepEqual(page?.map((r) => r.id), ['a', 'b', 'c']);
});

test('a tie on the timestamp is broken by id, not ignored', () => {
  // Edge is `d`; `c` shares its millisecond and must still count as older.
  const page = pageBefore(HISTORY, { createdAt: '2026-08-21T10:00:02.000Z', id: 'd' }, 1);
  assert.deepEqual(page?.map((r) => r.id), ['c']);
  // ...and from `c`, `d` is NOT older, so the page stops before it.
  const fromC = pageBefore(HISTORY, { createdAt: '2026-08-21T10:00:02.000Z', id: 'c' }, 2);
  assert.deepEqual(fromC?.map((r) => r.id), ['a', 'b']);
});

// A partial hit would have to be stitched to a server page, and that seam is
// exactly what this refuses to get wrong.
test('less than a whole page is refused rather than half-served', () => {
  assert.equal(pageBefore(HISTORY, { createdAt: '2026-08-21T10:00:01.000Z', id: 'b' }, 2), null);
  assert.equal(pageBefore([], { createdAt: '2026-08-21T10:00:00.000Z', id: 'a' }, 1), null);
});

test('Date and string timestamps are the same order', () => {
  const mixed = [
    { id: 'a', createdAt: new Date('2026-08-21T10:00:00.000Z') },
    { id: 'b', createdAt: '2026-08-21T10:00:01.000Z' },
  ];
  const page = pageBefore(mixed, { createdAt: '2026-08-21T10:00:02.000Z', id: 'z' }, 2);
  assert.deepEqual(page?.map((r) => r.id), ['a', 'b']);
});

// The size the warm-ahead fetch and the cache read must agree on: warming one
// page and then refusing to serve it because the reader wants a bigger one
// would spend the request and keep the wait.
test('a page is one size, and the warm fetch uses it', () => {
  assert.equal(OLDER_PAGE, 60);
  const many = Array.from({ length: OLDER_PAGE + 1 }, (_, i) =>
    row(`m${String(i).padStart(4, '0')}`, new Date(1_700_000_000_000 + i * 1000).toISOString()));
  const edge = many[many.length - 1];
  const page = pageBefore(many, { createdAt: edge.createdAt, id: edge.id }, OLDER_PAGE);
  assert.equal(page?.length, OLDER_PAGE);
  assert.equal(page?.[page.length - 1].id, many[many.length - 2].id);
});

// The commit seam: a page lands in several chunks, and between them the prepend
// anchor re-asserts. If a chunk duplicates or drops a row the reader meets a
// turn twice — or never — exactly the failure pageBefore exists to prevent.
test('a page is committed in chunks, newest first, with no dup and no gap', () => {
  const page = Array.from({ length: OLDER_PAGE }, (_, i) =>
    row(`p${String(i).padStart(3, '0')}`, new Date(1_700_000_000_000 + i * 1000).toISOString()));
  const chunks = chunksBottomFirst(page, COMMIT_CHUNK);
  assert.equal(chunks.length, OLDER_PAGE / COMMIT_CHUNK);
  // Newest chunk first: the rows nearest the reader land before the older ones.
  assert.equal(chunks[0][0].id, `p${String(OLDER_PAGE - COMMIT_CHUNK).padStart(3, '0')}`);
  // The seam: the newest chunk's first row is exactly one row after the oldest
  // chunk's last row — no gap, no overlap.
  const oldest = chunks[chunks.length - 1];
  assert.equal(oldest[oldest.length - 1].id, `p${String(OLDER_PAGE - COMMIT_CHUNK - 1).padStart(3, '0')}`);
  // All 60 ids, exactly once, in the original order once concatenated oldest-first.
  const flattened = chunks.flatMap((c) => c.map((r) => r.id));
  assert.equal(flattened.length, OLDER_PAGE);
  assert.equal(new Set(flattened).size, OLDER_PAGE);
  assert.deepEqual([...chunks[1].map((r) => r.id), ...chunks[0].map((r) => r.id)], page.map((r) => r.id));
});

test('a short page still commits whole, no empty chunk', () => {
  const page = Array.from({ length: COMMIT_CHUNK - 5 }, (_, i) =>
    row(`s${String(i).padStart(3, '0')}`, new Date(1_700_000_000_000 + i * 1000).toISOString()));
  const chunks = chunksBottomFirst(page, COMMIT_CHUNK);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, page.length);
  assert.deepEqual(chunks[0].map((r) => r.id), page.map((r) => r.id));
});

// --- allBefore: hand over the whole of what is already on disk ---------------

const at = (n: number) => `2026-08-22T10:${String(n).padStart(2, '0')}:00.000Z`;
const mk = (n: number) => ({ id: `m${String(n).padStart(3, '0')}`, createdAt: at(n) });

test('allBefore returns everything older, in order, with no minimum', () => {
  const rows = [mk(1), mk(2), mk(3), mk(4), mk(5)];
  const got = allBefore(rows, { createdAt: at(4), id: 'm004' });
  assert.deepEqual(got.map((r) => r.id), ['m001', 'm002', 'm003']);
});

test('a single row is enough — pageBefore would refuse it', () => {
  // This is the whole difference: a partial answer is useless to a pager and is
  // exactly what a one-shot preload wants.
  const rows = [mk(1)];
  const edge = { createdAt: at(2), id: 'm002' };
  assert.equal(pageBefore(rows, edge, 60), null);
  assert.equal(allBefore(rows, edge).length, 1);
});

test('nothing older is an empty list, not a null', () => {
  assert.deepEqual(allBefore([mk(5)], { createdAt: at(1), id: 'm001' }), []);
  assert.deepEqual(allBefore([], { createdAt: at(1), id: 'm001' }), []);
});

test('the edge row itself is excluded, and ties break by id', () => {
  // Same timestamp, which happens constantly: a turn's blocks land in one write.
  const same = [
    { id: 'a', createdAt: at(3) },
    { id: 'b', createdAt: at(3) },
    { id: 'c', createdAt: at(3) },
  ];
  assert.deepEqual(allBefore(same, { createdAt: at(3), id: 'b' }).map((r) => r.id), ['a']);
});

test('allBefore and pageBefore agree on the same seam', () => {
  // If these ever disagree the reader gets a turn twice, or loses one.
  const rows = Array.from({ length: 40 }, (_, i) => mk(i + 1));
  const edge = { createdAt: at(30), id: 'm030' };
  const all = allBefore(rows, edge);
  const page = pageBefore(rows, edge, 10);
  assert.ok(page);
  assert.deepEqual(page.map((r) => r.id), all.slice(all.length - 10).map((r) => r.id));
});

test('Date objects and ISO strings compare the same way', () => {
  const rows = [{ id: 'm001', createdAt: new Date(at(1)) }, { id: 'm002', createdAt: at(2) }];
  assert.deepEqual(allBefore(rows, { createdAt: at(2), id: 'm002' }).map((r) => r.id), ['m001']);
});
