import test from 'node:test';
import assert from 'node:assert/strict';
import { pageBefore, chunksBottomFirst, shedRows, absorbShed, shouldKeepShed, OLDER_PAGE, COMMIT_CHUNK } from './use-older-pages';

// The seam between a cached page and the rest of history. Getting it wrong does
// not throw — it shows a turn twice, or drops one, the next time someone reads
// back through a conversation they have already read.
//
// What makes a cached page trustworthy is the `nextId` each row was stamped with
// when it was written: the store itself is NOT contiguous (it accumulates live
// windows written minutes apart), so a page is served only when the links prove
// it is one unbroken run reaching the anchor.

/** A run exactly as the server hands one over: each row linked to the next. */
const run = (ids: string[], after?: string) =>
  ids.map((id, i) => ({ id, nextId: i + 1 < ids.length ? ids[i + 1] : after }));

/** One row with a timestamp, for the chunking tests, which only order by it. */
const row = (id: string, createdAt: string) => ({ id, createdAt });

const HISTORY = run(['a', 'b', 'c', 'd', 'e'], 'f');

test('a whole page comes back, newest-last', () => {
  assert.deepEqual(pageBefore(HISTORY, { id: 'e' }, 2)?.map((r) => r.id), ['c', 'd']);
});

test('the edge row itself is never included — that is the duplicate', () => {
  assert.deepEqual(pageBefore(HISTORY, { id: 'd' }, 3)?.map((r) => r.id), ['a', 'b', 'c']);
});

// A partial hit would have to be stitched to a server page, and that seam is
// exactly what this refuses to get wrong.
test('less than a whole page is refused rather than half-served', () => {
  assert.equal(pageBefore(HISTORY, { id: 'b' }, 2), null);
  assert.equal(pageBefore([], { id: 'a' }, 1), null);
});

// The store holds the live window AND, separately, the pages below it; only the
// pages carry a link up to the window's oldest row. Reading has to work from an
// anchor the store does not hold.
test('the anchor need not be in the store, only a row claiming to precede it', () => {
  assert.deepEqual(pageBefore(HISTORY, { id: 'f' }, 2)?.map((r) => r.id), ['d', 'e']);
});

// THE regression. Two runs written minutes apart, with the session having moved
// on in between: sorted together they look like one history, and the old
// implementation served straight across the gap. The page it handed back had a
// hole in the middle, and since paging only ever walks further back, nothing
// afterwards could repair it — it survived every reload.
test('a gap between two runs is refused, not jumped', () => {
  const store = [...run(['a', 'b', 'c']), ...run(['m', 'n', 'o'], 'p')];
  assert.equal(pageBefore(store, { id: 'p' }, 4), null);
  // The part that IS proven still serves.
  assert.deepEqual(pageBefore(store, { id: 'p' }, 3)?.map((r) => r.id), ['m', 'n', 'o']);
});

test('a row whose link points at something the store lost is refused', () => {
  const store = run(['a', 'b', 'c'], 'd').filter((r) => r.id !== 'b');
  assert.equal(pageBefore(store, { id: 'd' }, 2), null);
});

// An old cached row predates the links entirely. It must read as "unknown", not
// as "nothing comes after me".
test('unlinked rows are refused rather than guessed at', () => {
  const store = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(pageBefore(store, { id: 'd' }, 1), null);
});

// The size the warm-ahead fetch and the cache read must agree on: warming one
// page and then refusing to serve it because the reader wants a bigger one
// would spend the request and keep the wait.
test('a page is one size, and the warm fetch uses it', () => {
  assert.equal(OLDER_PAGE, 60);
  const many = run(Array.from({ length: OLDER_PAGE + 1 }, (_, i) => `m${String(i).padStart(4, '0')}`));
  const edge = many[many.length - 1];
  const page = pageBefore(many, { id: edge.id }, OLDER_PAGE);
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

// WHETHER to keep them is the caller's call now — absorbShed is arithmetic, and
// with nothing held it simply orders what it was given.
test('with no history on screen the shed rows are what is left', () => {
  const empty: ReturnType<typeof win> = [];
  assert.deepEqual(absorbShed(empty, win('02', '01')).map((r) => r.id), ['01', '02']);
});

// A reader at the tail sees nothing move when the head is trimmed — that is the
// whole point of a fixed window, and keeping the rows would grow the page for a
// conversation nobody is reading back through.
test('at the tail with no history on screen, shed rows are dropped', () => {
  assert.equal(shouldKeepShed({ historyOnScreen: false, followingTail: true }), false);
});

// History on screen: `older.rows` is anchored where the window used to start, so
// anything shed since belongs to neither array and the timeline closes over it.
test('history on screen keeps them even at the tail', () => {
  assert.equal(shouldKeepShed({ historyOnScreen: true, followingTail: true }), true);
});

// The reader has scrolled up: the shed row's HEIGHT leaves with it and slides
// their text up by that much, with no scroll write to explain it.
test('a reader who left the tail keeps them with no history loaded', () => {
  assert.equal(shouldKeepShed({ historyOnScreen: false, followingTail: false }), true);
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
