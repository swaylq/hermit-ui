import test from 'node:test';
import assert from 'node:assert/strict';
import { pageBefore, chunksBottomFirst, shedRows, absorbShed, OLDER_PAGE, COMMIT_CHUNK } from './use-older-pages';

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

// ── The hole between the live window and the history above it ───────────────
// The live window slides forward while a turn works; what it sheds is deleted
// from the query cache. If the reader has paged back, `older.rows` is anchored
// where the window used to start and the shed rows belong to neither array —
// the timeline concatenates the two and closes over the missing middle in
// silence. These pin the two halves of the fix.

const win = (...ids: string[]) =>
  ids.map((id) => ({ id, createdAt: `2026-08-27T10:00:${id.padStart(2, '0')}.000Z` }));

test('rows the window slid past are reported as shed', () => {
  const before = win('01', '02', '03', '04');
  const after = win('03', '04', '05', '06');
  assert.deepEqual(shedRows(before, after).map((r) => r.id), ['01', '02']);
});

test('a window that has not moved sheds nothing', () => {
  const w = win('01', '02', '03');
  assert.deepEqual(shedRows(w, w), []);
  // Growing at the tail without dropping anything is not shedding either.
  assert.deepEqual(shedRows(win('01', '02'), win('01', '02', '03')), []);
});

// `gone` also reports a row that was genuinely DELETED — an undelivered queue
// row being dequeued. Those sit inside the window, not off its old end, and
// must stay deleted rather than be resurrected as history.
test('a row deleted from inside the window is not shed', () => {
  const before = win('01', '02', '03', '04');
  const after = win('02', '04', '05'); // 01 slid off; 03 was deleted mid-window
  assert.deepEqual(shedRows(before, after).map((r) => r.id), ['01']);
});

test('shed rows land after the history already on screen', () => {
  const held = win('01', '02');
  const out = absorbShed(held, win('03', '04'));
  assert.deepEqual(out.map((r) => r.id), ['01', '02', '03', '04']);
});

// The reader is at the tail and has asked for no history: keeping everything
// the window sheds would grow the page for a conversation nobody is reading
// back through.
test('nothing is kept while no history is on screen', () => {
  const empty: ReturnType<typeof win> = [];
  assert.equal(absorbShed(empty, win('01', '02')), empty);
});

test('the same row twice does not appear twice', () => {
  const held = win('01', '02');
  const out = absorbShed(held, win('02', '03'));
  assert.deepEqual(out.map((r) => r.id), ['01', '02', '03']);
  // Nothing new at all hands the same array back, so React can bail.
  assert.equal(absorbShed(held, win('01')), held);
});

test('out-of-order arrivals are still ordered on screen', () => {
  const held = win('05', '06');
  // A late absorb carrying rows OLDER than what is held: correctness beats the
  // fast path, so the whole thing gets ordered.
  const out = absorbShed(held, win('04', '03'));
  assert.deepEqual(out.map((r) => r.id), ['03', '04', '05', '06']);
});

// The two halves together: page back, let the window slide, and the timeline's
// concatenation must still be one unbroken run.
test('paging back then letting the window slide leaves no gap', () => {
  const history = win('01', '02');          // older.rows, fetched by paging back
  const windowBefore = win('03', '04', '05');
  const windowAfter = win('05', '06', '07');
  const healed = absorbShed(history, shedRows(windowBefore, windowAfter));
  assert.deepEqual(
    [...healed, ...windowAfter].map((r) => r.id),
    ['01', '02', '03', '04', '05', '06', '07'],
  );
});
