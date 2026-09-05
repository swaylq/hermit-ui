/**
 * Renders `apps/ios/tools/fixtures/queue-cases.json` — the answers the WEB's own
 * queue logic gives today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:queue-fixture
 *
 * The strip above the composer looks like a list of strings and is in fact six
 * decisions, four of which are only interesting in the case that goes wrong:
 *
 *   · `queueDisplay` hides two kinds of row (a starter — the message that IS
 *     the imminent turn — and one the reader just pulled) and adds a third kind
 *     the server has not confirmed yet. The stubs are retired against the RAW
 *     server list, so a stub whose real row landed and is being hidden as a
 *     starter still retires. Match that against the filtered list and it stands
 *     forever.
 *   · `pruneToLive` KEEPS the ids still present and drops the ones that left,
 *     which is the opposite of how it reads.
 *   · `queuePollMs` counts the SERVER's rows, not the strip's.
 *   · `queueCancelTarget` asks the optimistic list, not the shape of the id.
 *
 * The table is produced by RUNNING those functions, and
 * `apps/ios/tools/queue-fixture.sh` runs the Swift side over the same table. A
 * red line there is always two implementations disagreeing, never an
 * implementation disagreeing with a test author.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  QUEUE_CLEAR_LABEL,
  QUEUE_POLL_MS,
  pruneToLive,
  queueCancelTarget,
  queueDisplay,
  queueIsFull,
  queueItemLabel,
  queuePollMs,
  queueSummary,
  type QueueRow,
  type QueueStub,
} from '../src/components/chat/queue-core';
import { QUEUE_LIMIT } from '../src/lib/chat-queue';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_JSON = 'apps/ios/tools/fixtures/queue-cases.json';

const t = (text: string): { type: 'text'; text: string }[] => [{ type: 'text', text }];

// ---------------------------------------------------------------------------
// queueDisplay — what the strip shows
// ---------------------------------------------------------------------------

type DisplayCase = {
  why: string;
  server: QueueRow[];
  starters: string[];
  cancelled: string[];
  optimistic: QueueStub[];
};

const DISPLAY: DisplayCase[] = [
  { why: 'nothing anywhere', server: [], starters: [], cancelled: [], optimistic: [] },
  {
    why: 'two queued rows, nothing hidden — server order is kept',
    server: [{ id: 'q1', content: t('first') }, { id: 'q2', content: t('second') }],
    starters: [], cancelled: [], optimistic: [],
  },
  {
    why: 'the starter is the imminent turn, not a queue item: hidden',
    server: [{ id: 'q1', content: t('the one running') }, { id: 'q2', content: t('behind it') }],
    starters: ['q1'], cancelled: [], optimistic: [],
  },
  {
    why: 'a row the reader just pulled is hidden before dequeue answers',
    server: [{ id: 'q1', content: t('keep') }, { id: 'q2', content: t('pulled') }],
    starters: [], cancelled: ['q2'], optimistic: [],
  },
  {
    why: 'both sets naming the same row hide it once, not twice',
    server: [{ id: 'q1', content: t('gone') }],
    starters: ['q1'], cancelled: ['q1'], optimistic: [],
  },
  {
    why: 'an id in neither list that names no row changes nothing',
    server: [{ id: 'q1', content: t('here') }],
    starters: ['nope'], cancelled: ['also-nope'], optimistic: [],
  },
  {
    why: 'a stub the server has not confirmed shows, and shows LAST',
    server: [{ id: 'q1', content: t('already queued') }],
    starters: [], cancelled: [],
    optimistic: [{ id: 'c1', content: t('just typed') }],
  },
  {
    why: 'a stub whose realId is in the queue has landed: gone',
    server: [{ id: 'q1', content: t('server wording') }],
    starters: [], cancelled: [],
    optimistic: [{ id: 'c1', realId: 'q1', content: t('typed wording') }],
  },
  {
    why: 'a stub whose realId is NOT in the queue stays, even when text matches another row',
    server: [{ id: 'q1', content: t('same words') }],
    starters: [], cancelled: [],
    optimistic: [{ id: 'c1', realId: 'q9', content: t('same words') }],
  },
  {
    why: 'THE ONE THAT BITES: the stub landed as a starter — hidden from the strip, still landed',
    server: [{ id: 'q1', content: t('hello') }],
    starters: ['q1'], cancelled: [],
    optimistic: [{ id: 'c1', realId: 'q1', content: t('hello') }],
  },
  {
    why: '…same, by the text fallback rather than by id',
    server: [{ id: 'q1', content: t('hello') }],
    starters: ['q1'], cancelled: [],
    optimistic: [{ id: 'c1', content: t('hello') }],
  },
  {
    why: 'no realId yet: text is the fallback and it matches',
    server: [{ id: 'q1', content: t('hello') }],
    starters: [], cancelled: [],
    optimistic: [{ id: 'c1', content: t('hello') }],
  },
  {
    why: 'each real row claims at most ONE stub: the same sentence sent twice',
    server: [{ id: 'q1', content: t('again') }],
    starters: [], cancelled: [],
    optimistic: [{ id: 'c1', content: t('again') }, { id: 'c2', content: t('again') }],
  },
  {
    why: 'the trailing-whitespace trap: msgText trims, so these are the same text',
    server: [{ id: 'q1', content: t('  spaced  ') }],
    starters: [], cancelled: [],
    optimistic: [{ id: 'c1', content: t('spaced') }],
  },
  {
    why: 'U+FEFF is stripped by JS trim and not by CharacterSet.whitespacesAndNewlines',
    server: [{ id: 'q1', content: t('﻿bom') }],
    starters: [], cancelled: [],
    optimistic: [{ id: 'c1', content: t('bom') }],
  },
  {
    why: 'a full strip: three server rows, one hidden, two stubs, one of them landed',
    server: [
      { id: 'q1', content: t('one') },
      { id: 'q2', content: t('two') },
      { id: 'q3', content: t('three') },
    ],
    starters: ['q1'], cancelled: [],
    optimistic: [
      { id: 'c1', realId: 'q3', content: t('three') },
      { id: 'c2', content: t('four') },
    ],
  },
];

const display = DISPLAY.map((c) => ({
  ...c,
  expected: queueDisplay(
    c.server,
    { starters: new Set(c.starters), cancelled: new Set(c.cancelled) },
    c.optimistic,
  ).map((m) => m.id),
}));

// ---------------------------------------------------------------------------
// pruneToLive — keeping the two hidden-id sets bounded
// ---------------------------------------------------------------------------

const PRUNE: { why: string; ids: string[]; live: string[] }[] = [
  { why: 'nothing remembered', ids: [], live: ['q1'] },
  { why: 'every remembered id is still queued: all kept', ids: ['q1', 'q2'], live: ['q1', 'q2'] },
  { why: 'one has been delivered and left the queue', ids: ['q1', 'q2'], live: ['q2'] },
  { why: 'the queue drained: everything is forgotten', ids: ['q1', 'q2'], live: [] },
  { why: 'rows nobody is hiding do not enter the set', ids: ['q1'], live: ['q1', 'q7', 'q8'] },
  { why: 'an id that never named a row is dropped on the first prune', ids: ['ghost'], live: ['q1'] },
];

const prune = PRUNE.map((c) => ({ ...c, expected: pruneToLive(c.ids, c.live).slice().sort() }));

// ---------------------------------------------------------------------------
// queuePollMs — when to ask again
// ---------------------------------------------------------------------------

const POLL: { why: string; inFlight: boolean; serverCount: number }[] = [
  { why: 'idle and empty: nothing can change it', inFlight: false, serverCount: 0 },
  { why: 'idle but something is queued — the reader can still pull it', inFlight: false, serverCount: 1 },
  { why: 'a turn is running: the gateway will drain as it ends', inFlight: true, serverCount: 0 },
  { why: 'both', inFlight: true, serverCount: 3 },
];

const poll = POLL.map((c) => ({ ...c, expected: queuePollMs(c.inFlight, c.serverCount) }));

// ---------------------------------------------------------------------------
// queueCancelTarget — a ✕ that deletes a row, or one that forgets a stub
// ---------------------------------------------------------------------------

const CANCEL: { why: string; id: string; optimisticIds: string[] }[] = [
  { why: 'a stub this client made up', id: 'c1', optimisticIds: ['c1', 'c2'] },
  { why: 'a real queued row', id: 'q1', optimisticIds: ['c1'] },
  { why: 'nothing optimistic at all', id: 'q1', optimisticIds: [] },
  {
    why: 'an id SHAPED like the web\'s stubs but not in the list is still a server row',
    id: 'pending-1757000000000-abcdef', optimisticIds: ['c1'],
  },
  {
    why: 'the iOS shape — an idempotency key — is a stub when the list says so',
    id: '3f2504e0-4f89:1757000000000-x7', optimisticIds: ['3f2504e0-4f89:1757000000000-x7'],
  },
];

const cancel = CANCEL.map((c) => ({ ...c, expected: queueCancelTarget(c.id, c.optimisticIds) }));

// ---------------------------------------------------------------------------
// The strings, and the rung
// ---------------------------------------------------------------------------

const summaries = [0, 1, 2, 5, 12].map((n) => ({ n, expected: queueSummary(n) }));

const LABELS: { why: string; preview: string }[] = [
  { why: 'ordinary prose', preview: '把这一屏也做成原生的' },
  { why: 'empty — the message is attachments and nothing else', preview: '' },
  { why: 'NOT a trim: spaces are prose as far as this is concerned', preview: '   ' },
  { why: 'a zero the JS falsy check must not swallow', preview: '0' },
];
const labels = LABELS.map((c) => ({ ...c, expected: queueItemLabel(c.preview) }));

const full = [0, 1, QUEUE_LIMIT - 1, QUEUE_LIMIT, QUEUE_LIMIT + 1, 99].map((n) => ({
  n,
  expected: queueIsFull(n),
}));

// ---------------------------------------------------------------------------

const out = {
  queueLimit: QUEUE_LIMIT,
  pollMs: QUEUE_POLL_MS,
  clearLabel: QUEUE_CLEAR_LABEL,
  display,
  prune,
  poll,
  cancel,
  summaries,
  labels,
  full,
};

const path = join(REPO_ROOT, FIXTURE_JSON);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
const count =
  display.length + prune.length + poll.length + cancel.length + summaries.length + labels.length + full.length;
console.log(`wrote ${FIXTURE_JSON} — ${count} cases`);
