/**
 * Renders `apps/ios/tools/fixtures/merge-cases.json` — the answers THIS
 * repository's merge and paging code gives today, for the Swift port to be held
 * against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:merge-fixture
 *
 * Two files are covered, both on the timeline's data plane:
 *
 *   · `src/lib/chat-cache/merge-messages.ts` — how a stream push becomes the
 *     window on screen (`applyMessagePush`, `foldPushes`). Ported to
 *     `apps/ios/Hermit/TimelineMerge.swift`.
 *   · `src/components/chat/use-older-pages.ts` — what "load earlier" does with
 *     the rows the live window sheds while history is on screen (`shedRows`,
 *     `shouldKeepShed`, `absorbShed`). Ported to
 *     `apps/ios/Hermit/TimelinePager.swift`.
 *
 * Neither file's ordering helper is exported, and neither needs to be: `order`
 * is exercised through `applyMessagePush` and `isOlder` through `shedRows` and
 * `absorbShed`, which is where a wrong answer would actually be seen.
 *
 * The INPUTS below are hand-written. The EXPECTATIONS are not — every one of
 * them comes out of calling the real function, so a red line in the Swift driver
 * is always two implementations disagreeing, never a test author's reading of
 * one of them.
 *
 * No time zone pin here, unlike the fold fixture: nothing in these two files
 * asks the local calendar anything. `order` parses instants and `isOlder`
 * compares the ISO strings, and both are absolute.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { applyMessagePush, foldPushes, type CachedMsg } from '../src/lib/chat-cache/merge-messages';
import { shedRows, shouldKeepShed, absorbShed } from '../src/components/chat/use-older-pages';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = 'apps/ios/tools/fixtures/merge-cases.json';

// ── the row shape both sides read ───────────────────────────────────────────
// `createdAt` is a STRING everywhere in this fixture. The web's own type allows
// a Date, and the live query holds Dates — but the JSON on the wire, the JSON in
// the cache and the JSON in this file are all strings, and a fixture that fed
// one side Dates and the other side strings would be comparing two different
// questions.

type Row = { id: string; role: string; content: unknown; createdAt: string; authoredBy?: string | null };

const text = (t: string) => [{ type: 'text', text: t }];

const row = (id: string, createdAt: string, content: unknown = text(id), role = 'assistant'): Row => ({
  id,
  role,
  content,
  createdAt,
  authoredBy: null,
});

/** `2026-08-21T10:0m:0sZ`, with milliseconds, which is what `toISOString()` gives. */
const at = (m: number, s = 0, ms = 0) =>
  `2026-08-21T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`;

/** The same instant WITHOUT the fractional part — what a raw Postgres timestamp can look like. */
const atBare = (m: number, s = 0) => `2026-08-21T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`;

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

// ── applyMessagePush ────────────────────────────────────────────────────────

const W = [row('a', at(0)), row('b', at(1)), row('c', at(2))];

const APPLY: Array<{ name: string; prev: Row[] | null; next: Row[]; gone?: string[] }> = [
  {
    // The empty-window branch does NOT sort, deliberately — see the comment on
    // it. A port that "helpfully" sorted here would differ from the web on
    // exactly the payload the server chose the order of.
    name: 'empty window keeps the server order, unsorted',
    prev: null,
    next: [row('c', at(2)), row('a', at(0)), row('b', at(1))],
  },
  { name: 'empty array counts as an empty window', prev: [], next: [row('a', at(0))] },
  {
    name: 'empty window still honours gone',
    prev: null,
    next: [row('a', at(0)), row('b', at(1))],
    gone: ['a'],
  },
  { name: 'a delta appends one row', prev: W, next: [row('d', at(3))] },
  { name: 'a full window re-sent changes nothing', prev: W, next: W },
  {
    name: 'one row grew a sentence',
    prev: W,
    next: [row('b', at(1), text('b, now longer'))],
  },
  { name: 'gone removes a row', prev: W, next: [], gone: ['b'] },
  { name: 'gone for an id nobody holds is a no-op', prev: W, next: [], gone: ['zz'] },
  {
    // `next` is applied first and `gone` second, so an id in both leaves.
    name: 'a row in next AND in gone leaves',
    prev: W,
    next: [row('d', at(3))],
    gone: ['d'],
  },
  {
    name: 'out-of-order rows come back sorted',
    prev: [row('b', at(1))],
    next: [row('d', at(3)), row('a', at(0)), row('c', at(2))],
  },
  {
    // The whole reason the Swift port parses instants instead of comparing the
    // ISO strings: '…:00.500Z' sorts BEFORE '…:00Z' byte-wise, because '.'
    // (0x2E) is below 'Z' (0x5A).
    name: 'a bare-second timestamp sorts by instant, not by bytes',
    prev: [row('anchor', at(0))],
    next: [row('half', at(1, 0, 500)), row('whole', atBare(1))],
  },
  {
    name: 'the same instant is broken by id',
    prev: [row('anchor', at(0))],
    next: [row('m2', at(1)), row('m1', at(1)), row('m3', at(1))],
  },
  {
    name: 'a duplicate id in one push keeps the last copy',
    prev: [row('anchor', at(0))],
    next: [row('dup', at(1), text('first')), row('dup', at(1), text('second'))],
  },
  {
    name: 'authoredBy travels with the row',
    prev: W,
    next: [{ ...row('brainrow', at(3)), authoredBy: 'brain' }],
  },
];

// ── foldPushes ──────────────────────────────────────────────────────────────
//
// The frames that land in the gap between the stream opening and the window
// query answering. Applying them one at a time to nothing is the bug this
// exists to prevent: 13 rows of a live session became the 1 row the push
// carried.

const FOLD: Array<{ name: string; base: Row[] | null; frames: Array<{ rows: Row[]; gone?: string[] }> }> = [
  { name: 'no frames, no change', base: W, frames: [] },
  {
    name: 'three frames held, then the window lands under them',
    base: W,
    frames: [{ rows: [row('d', at(3))] }, { rows: [row('e', at(4))] }, { rows: [row('f', at(5))] }],
  },
  {
    // With no window to fold onto, the frames ARE the window — which is
    // precisely why the screen holds them instead of applying them.
    name: 'frames onto nothing are the frames',
    base: null,
    frames: [{ rows: [row('d', at(3))] }, { rows: [row('e', at(4))] }],
  },
  {
    name: 'a later frame overwrites an earlier version of the same row',
    base: W,
    frames: [
      { rows: [row('d', at(3), text('typing'))] },
      { rows: [row('d', at(3), text('typing…'))] },
      { rows: [row('d', at(3), text('typing… done'))] },
    ],
  },
  {
    name: 'a row reported gone in a held frame stays gone',
    base: W,
    frames: [{ rows: [row('d', at(3))] }, { rows: [], gone: ['b'] }, { rows: [row('e', at(4))] }],
  },
  {
    name: 'a row that arrives and then leaves within the held frames',
    base: W,
    frames: [{ rows: [row('q', at(3))] }, { rows: [row('e', at(4))], gone: ['q'] }],
  },
];

// ── shedRows / shouldKeepShed / absorbShed ──────────────────────────────────
//
// What the live window drops off its OLD end between two renders. Without this,
// the rows shed while the reader has history on screen belong to neither array
// the timeline concatenates, and the gap closes over silently.

const SHED: Array<{ name: string; prev: Row[]; next: Row[] }> = [
  { name: 'nothing held, nothing shed', prev: [], next: W },
  { name: 'nothing arrived, nothing shed', prev: W, next: [] },
  { name: 'the window did not move', prev: W, next: W },
  {
    name: 'the window slid forward by two',
    prev: [row('a', at(0)), row('b', at(1)), row('c', at(2))],
    next: [row('c', at(2)), row('d', at(3)), row('e', at(4))],
  },
  {
    // A row deleted from INSIDE the window (dequeuing an undelivered queue row)
    // is newer than the new window's first row, so it is dropped rather than
    // resurrected as history.
    name: 'a row deleted from inside the window is not shed',
    prev: [row('a', at(0)), row('b', at(1)), row('c', at(2))],
    next: [row('a', at(0)), row('c', at(2))],
  },
  {
    name: 'the window jumped past everything held',
    prev: [row('a', at(0)), row('b', at(1))],
    next: [row('y', at(8)), row('z', at(9))],
  },
];

const KEEP_SHED = [
  { historyOnScreen: false, followingTail: true },
  { historyOnScreen: false, followingTail: false },
  { historyOnScreen: true, followingTail: true },
  { historyOnScreen: true, followingTail: false },
];

const ABSORB: Array<{ name: string; rows: Row[]; shed: Row[] }> = [
  { name: 'nothing to absorb', rows: [row('a', at(0))], shed: [] },
  { name: 'every shed row is already held', rows: W, shed: [row('b', at(1))] },
  { name: 'shed rows land after the history already held', rows: [row('a', at(0))], shed: [row('b', at(1)), row('c', at(2))] },
  { name: 'shed rows arrive out of order', rows: [row('a', at(0))], shed: [row('c', at(2)), row('b', at(1))] },
  {
    // The concatenation is normally already ordered — shed rows come off the
    // window that sat directly after `rows`. When it is not, the whole thing is
    // re-sorted, and this is the case that proves the branch runs.
    name: 'a shed row older than the history held forces a full re-sort',
    rows: [row('c', at(2)), row('d', at(3))],
    shed: [row('a', at(0)), row('b', at(1))],
  },
  { name: 'absorbing into an empty history', rows: [], shed: [row('a', at(0)), row('b', at(1))] },
];

// ── the two orderings do not agree, and both sides must reproduce that ──────
//
// `merge-messages.ts` parses the instants; `use-older-pages.ts` compares the ISO
// strings. On the shapes the server actually sends today (superjson writes
// `toISOString()`, always three fractional digits) they agree on everything. On
// a bare-second timestamp they do not, and the difference is not academic: the
// pager would decide a row that IS older than the window's edge is not, and drop
// it instead of absorbing it — the same missing middle `shedRows` exists to
// prevent.
//
// Pinned here rather than fixed. Fixing it is a change to the WEB's behaviour
// and belongs in its own round; what this section buys is that neither side can
// drift without the other, and that nobody "tidies" the Swift port into
// agreement with itself and silently diverges from the browser.

const SKEW_BARE = row('whole', atBare(1));
const SKEW_HALF = row('half', at(1, 0, 500));

const skew = {
  note: 'merge-messages parses instants; use-older-pages compares ISO strings. They disagree here.',
  bare: SKEW_BARE,
  half: SKEW_HALF,
  // What `applyMessagePush` makes of the pair — the instant ordering.
  mergeOrder: ids(applyMessagePush([row('anchor', at(0))], [SKEW_HALF, SKEW_BARE])),
  // What `shedRows` makes of it — the byte ordering. The bare-second row is NOT
  // seen as older than the fractional one, so it is not shed.
  shedKeeps: ids(shedRows([SKEW_BARE], [SKEW_HALF])),
};

// ── write ───────────────────────────────────────────────────────────────────

const fixture = {
  note: 'GENERATED by apps/dashboard/scripts/gen-merge-fixture.ts — do not hand-edit.',
  apply: APPLY.map((c) => ({
    name: c.name,
    prev: c.prev,
    next: c.next,
    gone: c.gone ?? null,
    expected: applyMessagePush(c.prev as CachedMsg[] | undefined, c.next as CachedMsg[], c.gone),
  })),
  fold: FOLD.map((c) => ({
    name: c.name,
    base: c.base,
    frames: c.frames.map((f) => ({ rows: f.rows, gone: f.gone ?? null })),
    expected: foldPushes(c.base as CachedMsg[] | undefined, c.frames as { rows: CachedMsg[]; gone?: string[] }[]),
  })),
  shed: SHED.map((c) => ({
    name: c.name,
    prev: c.prev,
    next: c.next,
    expected: shedRows(c.prev, c.next),
  })),
  keepShed: KEEP_SHED.map((c) => ({ ...c, expected: shouldKeepShed(c) })),
  absorb: ABSORB.map((c) => ({
    name: c.name,
    rows: c.rows,
    shed: c.shed,
    expected: absorbShed(c.rows, c.shed),
  })),
  orderSkew: skew,
};

// A generator that quietly wrote an empty section would hand the driver a green
// run that checked nothing.
for (const [k, v] of Object.entries(fixture)) {
  if (Array.isArray(v) && v.length === 0) throw new Error(`section '${k}' is empty`);
}
// The skew is the point of that section; if the two orderings ever agree here,
// the note above is stale and the section is asserting nothing.
if (JSON.stringify(skew.mergeOrder) === JSON.stringify(['anchor', ...ids([SKEW_HALF, SKEW_BARE])])) {
  throw new Error('the orderings now agree — rewrite the orderSkew section instead of shipping a claim that is no longer true');
}

const dest = join(REPO_ROOT, OUT);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(fixture, null, 2) + '\n');
console.log(
  `${OUT}: ${fixture.apply.length} apply · ${fixture.fold.length} fold · ${fixture.shed.length} shed · ` +
    `${fixture.keepShed.length} keepShed · ${fixture.absorb.length} absorb · skew ${skew.mergeOrder.join(',')}`
);
