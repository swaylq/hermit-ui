/**
 * Renders `apps/ios/tools/fixtures/composer-cases.json` — the answers the WEB's
 * own composer logic gives today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:composer-fixture
 *
 * Four decisions, and every one of them is small enough to look obviously right
 * and not be:
 *
 *   · `dropLanded` retires an optimistic bubble when its REAL row lands. By
 *     `realId` once the send has answered; by TEXT before that, and the text
 *     path is a budget — each real row claims at most one optimistic row, so
 *     the same sentence sent twice in a row leaves one bubble standing. Text
 *     comes from `msgText`, which is `trim()`ed, and JavaScript's `trim` removes
 *     U+FEFF while `CharacterSet.whitespacesAndNewlines` does not.
 *   · `composerPlaceholder` is a LADDER, and the order is the whole content of
 *     it: a closed session outranks a full queue, and `working` sits under both
 *     so "↵ to queue next" is never offered where queueing would fail.
 *   · `composerCanSend` deliberately ignores `working` — a message typed during
 *     a running turn is queued, not refused — and reads `draft.trim()`, so it
 *     inherits the same U+FEFF trap.
 *   · `turnInFlight` decides whether a turn is running from four timestamps.
 *     `snapTime > lastMsgTime + DELIVERY_GRACE_MS` is a STRICT inequality, the
 *     90s escape hatch is strict too, and an optimistic row wins over the newest
 *     server row even when the server row is newer.
 *
 * Plus `CLIENT_ID_RE`, the charset a `chat.send` idempotency key may use. The
 * iOS composer mints those, so the pattern is a two-implementation question the
 * same way the four functions are.
 *
 * The table is produced by RUNNING those functions, and
 * `apps/ios/tools/composer-fixture.sh` runs the Swift side over the same table.
 * A red line there is always two implementations disagreeing, never an
 * implementation disagreeing with a test author.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  composerCanSend,
  composerPlaceholder,
  dropLanded,
  stopPill,
  turnInFlight,
  type ComposerFace,
  type TurnSignals,
} from '../src/components/chat/composer-core';
import { CLIENT_ID_RE, QUEUE_LIMIT } from '../src/lib/chat-queue';
import { DELIVERY_GRACE_MS } from '../src/lib/session-status';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_JSON = 'apps/ios/tools/fixtures/composer-cases.json';

// ---------------------------------------------------------------------------
// dropLanded — the id path, the text budget, and what msgText counts as text
// ---------------------------------------------------------------------------

type Opt = { id: string; realId?: string; content: { type: 'text'; text: string }[] };
type Real = { id: string; content: unknown };

const t = (text: string): { type: 'text'; text: string }[] => [{ type: 'text', text }];

const LANDED: { why: string; optimistic: Opt[]; real: Real[] }[] = [
  { why: 'nothing optimistic, nothing to do', optimistic: [], real: [{ id: 'r1', content: t('hi') }] },
  {
    why: 'a realId that has landed retires its bubble',
    optimistic: [{ id: 'p1', realId: 'r1', content: t('hello') }],
    real: [{ id: 'r1', content: t('hello') }],
  },
  {
    why: 'a realId that has NOT landed stays, even when the text matches something else',
    optimistic: [{ id: 'p1', realId: 'r9', content: t('hello') }],
    real: [{ id: 'r1', content: t('hello') }],
  },
  {
    why: 'no realId yet: the text is the fallback, and it matches',
    optimistic: [{ id: 'p1', content: t('hello') }],
    real: [{ id: 'r1', content: t('hello') }],
  },
  {
    why: 'the translate case — real row English, bubble Chinese, no realId: it stays',
    optimistic: [{ id: 'p1', content: t('你好') }],
    real: [{ id: 'r1', content: t('hello') }],
  },
  {
    why: 'each real row claims at most ONE bubble: two identical sends, one row landed',
    optimistic: [{ id: 'p1', content: t('again') }, { id: 'p2', content: t('again') }],
    real: [{ id: 'r1', content: t('again') }],
  },
  {
    why: '…and two rows landed retires both',
    optimistic: [{ id: 'p1', content: t('again') }, { id: 'p2', content: t('again') }],
    real: [{ id: 'r1', content: t('again') }, { id: 'r2', content: t('again') }],
  },
  {
    why: 'a realId bubble does not eat the text budget the other one needs',
    optimistic: [{ id: 'p1', realId: 'r1', content: t('again') }, { id: 'p2', content: t('again') }],
    real: [{ id: 'r1', content: t('again') }],
  },
  {
    why: 'msgText trims, so trailing whitespace on either side still matches',
    optimistic: [{ id: 'p1', content: t('  spaced  ') }],
    real: [{ id: 'r1', content: t('spaced') }],
  },
  {
    why: 'msgText joins EVERY text block and only text blocks',
    optimistic: [{ id: 'p1', content: t('look at this') }],
    real: [{ id: 'r1', content: [{ type: 'text', text: 'look at ' }, { type: 'image', source: { type: 'url', url: 'u' } }, { type: 'text', text: 'this' }] }],
  },
  {
    why: 'a tool_result row is text-empty, so an EMPTY bubble matches it — the web does this too',
    optimistic: [{ id: 'p1', content: t('') }],
    real: [{ id: 'r1', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }] }],
  },
  {
    why: 'content that is not an array at all is text-empty',
    optimistic: [{ id: 'p1', content: t('') }],
    real: [{ id: 'r1', content: null }],
  },
  {
    why: 'a bare string content IS its text (parseBlocks says so)',
    optimistic: [{ id: 'p1', content: t('plain') }],
    real: [{ id: 'r1', content: 'plain' }],
  },
  {
    why: 'U+FEFF is whitespace to JS trim and not to CharacterSet.whitespacesAndNewlines',
    optimistic: [{ id: 'p1', content: t('\ufeffbom\ufeff') }],
    real: [{ id: 'r1', content: t('bom') }],
  },
  {
    why: 'U+200B is NOT whitespace to either — this pair must NOT match',
    optimistic: [{ id: 'p1', content: t('\u200bzwsp') }],
    real: [{ id: 'r1', content: t('zwsp') }],
  },
  {
    why: 'the ideographic space U+3000 is trimmed',
    optimistic: [{ id: 'p1', content: t('\u3000ideo\u3000') }],
    real: [{ id: 'r1', content: t('ideo') }],
  },
];

// ---------------------------------------------------------------------------
// composerPlaceholder — every rung, and the rungs above it
// ---------------------------------------------------------------------------

const FACE: ComposerFace = {
  disabled: false, awaitingInput: false, queueFull: false, working: false,
  uploadingCount: 0, dictating: false, touch: false, brainGhost: false,
};
const face = (o: Partial<ComposerFace>): ComposerFace => ({ ...FACE, ...o });

const PLACEHOLDERS: { why: string; face: ComposerFace }[] = [
  { why: 'resting, desktop', face: face({}) },
  { why: 'resting, touch — the hold gesture only exists there', face: face({ touch: true }) },
  { why: 'closed', face: face({ disabled: true }) },
  { why: 'closed outranks everything below it', face: face({ disabled: true, awaitingInput: true, queueFull: true, working: true, uploadingCount: 3, dictating: true, touch: true }) },
  { why: 'the brain ghost outranks even closed — it owns the pixels', face: face({ brainGhost: true, disabled: true }) },
  { why: 'awaiting an interaction card', face: face({ awaitingInput: true }) },
  { why: 'awaiting outranks a full queue', face: face({ awaitingInput: true, queueFull: true, working: true }) },
  { why: 'queue full', face: face({ queueFull: true }) },
  { why: 'queue full outranks working — queueing is what would fail', face: face({ queueFull: true, working: true }) },
  { why: 'working', face: face({ working: true }) },
  { why: 'working outranks an upload in flight', face: face({ working: true, uploadingCount: 2 }) },
  { why: 'uploading, one', face: face({ uploadingCount: 1 }) },
  { why: 'uploading, several', face: face({ uploadingCount: 7 }) },
  { why: 'uploading outranks dictating', face: face({ uploadingCount: 1, dictating: true }) },
  { why: 'dictating', face: face({ dictating: true }) },
  { why: 'dictating outranks the touch hint', face: face({ dictating: true, touch: true }) },
  { why: 'a negative upload count is not "uploading" — the guard is > 0', face: face({ uploadingCount: -1 }) },
];

// ---------------------------------------------------------------------------
// composerCanSend
// ---------------------------------------------------------------------------

type SendCase = {
  disabled: boolean; awaitingInput: boolean; queueFull: boolean;
  uploadingCount: number; draft: string; readyAttachments: number;
};
const SEND_BASE: SendCase = {
  disabled: false, awaitingInput: false, queueFull: false,
  uploadingCount: 0, draft: '', readyAttachments: 0,
};
const send = (o: Partial<SendCase>): SendCase => ({ ...SEND_BASE, ...o });

const CAN_SEND: { why: string; input: SendCase }[] = [
  { why: 'an empty box sends nothing', input: send({}) },
  { why: 'text', input: send({ draft: 'hi' }) },
  { why: 'whitespace only is not text', input: send({ draft: '   \n\t ' }) },
  { why: 'U+FEFF only is not text to JS trim', input: send({ draft: '\ufeff' }) },
  { why: 'U+00A0 only is not text', input: send({ draft: '\u00a0' }) },
  { why: 'U+200B only IS text — not whitespace anywhere', input: send({ draft: '\u200b' }) },
  { why: 'U+2028 (line separator) only is not text', input: send({ draft: '\u2028' }) },
  { why: 'an attachment alone is enough', input: send({ readyAttachments: 1 }) },
  { why: 'an attachment still uploading is not', input: send({ readyAttachments: 1, uploadingCount: 1 }) },
  { why: 'working is NOT in here: a send during a turn is a queue item', input: send({ draft: 'hi' }) },
  { why: 'closed', input: send({ draft: 'hi', disabled: true }) },
  { why: 'awaiting an interaction card', input: send({ draft: 'hi', awaitingInput: true }) },
  { why: 'queue full', input: send({ draft: 'hi', queueFull: true }) },
];

// ---------------------------------------------------------------------------
// turnInFlight — four timestamps and a strict inequality on each end
// ---------------------------------------------------------------------------

const T0 = 1_757_000_000_000; // a fixed "now", so the table is reproducible
const BASE: TurnSignals = {
  statusState: null, snapshotAt: null, lastRole: null, lastAt: null,
  optimisticAt: null, streamingTail: false, now: T0,
};
const sig = (o: Partial<TurnSignals>): TurnSignals => ({ ...BASE, ...o });

const FLIGHT: { why: string; input: TurnSignals }[] = [
  { why: 'an empty session is not in flight', input: sig({}) },
  { why: 'the newest row is the assistant, nothing streaming', input: sig({ lastRole: 'assistant', lastAt: T0 - 1000, statusState: 'idle', snapshotAt: T0 }) },
  { why: '…and the same row still growing IS in flight, though not waiting', input: sig({ lastRole: 'assistant', lastAt: T0 - 1000, statusState: 'idle', snapshotAt: T0, streamingTail: true }) },
  { why: 'the newest row is the user and the pane is working', input: sig({ lastRole: 'user', lastAt: T0 - 1000, statusState: 'working', snapshotAt: T0 }) },
  { why: 'the newest row is the user and there is no status row at all', input: sig({ lastRole: 'user', lastAt: T0 - 1000 }) },
  { why: 'idle, snapshot exactly at lastMsg + grace — NOT settled, the test is strict', input: sig({ lastRole: 'user', lastAt: T0 - 10_000, statusState: 'idle', snapshotAt: T0 - 10_000 + DELIVERY_GRACE_MS }) },
  { why: 'idle, snapshot one ms past that — settled', input: sig({ lastRole: 'user', lastAt: T0 - 10_000, statusState: 'idle', snapshotAt: T0 - 10_000 + DELIVERY_GRACE_MS + 1 }) },
  { why: 'idle, snapshot older than the message — the gateway has not seen it', input: sig({ lastRole: 'user', lastAt: T0 - 1000, statusState: 'idle', snapshotAt: T0 - 60_000 }) },
  { why: 'idle, no snapshot, message exactly 90s old — NOT settled, strict again', input: sig({ lastRole: 'user', lastAt: T0 - 90_000, statusState: 'idle' }) },
  { why: 'idle, no snapshot, message 90s + 1ms old — settled', input: sig({ lastRole: 'user', lastAt: T0 - 90_001, statusState: 'idle' }) },
  { why: 'working, message ancient — the 90s hatch is idle-only', input: sig({ lastRole: 'user', lastAt: T0 - 900_000, statusState: 'working' }) },
  { why: 'an optimistic row makes the newest message the user’s, whatever the server says', input: sig({ lastRole: 'assistant', lastAt: T0 - 1000, optimisticAt: T0, statusState: 'idle', snapshotAt: T0 }) },
  { why: 'and the optimistic row’s clock is the one that counts, even when the server row is NEWER', input: sig({ lastRole: 'assistant', lastAt: T0, optimisticAt: T0 - 200_000, statusState: 'idle', snapshotAt: T0 - 100_000 }) },
  { why: 'a session with no messages but an idle status is settled', input: sig({ statusState: 'idle', snapshotAt: T0 }) },
  { why: 'blocked is not idle, but the newest row is the assistant', input: sig({ lastRole: 'assistant', lastAt: T0 - 1000, statusState: 'blocked' }) },
  { why: 'blocked with an unanswered user row on top: waiting', input: sig({ lastRole: 'user', lastAt: T0 - 1000, statusState: 'blocked', snapshotAt: T0 }) },
];

// ---------------------------------------------------------------------------
// stopPill
// ---------------------------------------------------------------------------

const STOP: { why: string; inFlight: boolean; statusKey: string; closed: boolean }[] = [
  { why: 'resting', inFlight: false, statusKey: 'ready', closed: false },
  { why: 'the local signal alone is enough', inFlight: true, statusKey: 'ready', closed: false },
  { why: 'the gateway’s working alone is enough — this is the long-tool-call case', inFlight: false, statusKey: 'working', closed: false },
  { why: 'both', inFlight: true, statusKey: 'working', closed: false },
  { why: 'closed hides the pill but the turn is still “running” for Escape', inFlight: true, statusKey: 'working', closed: true },
  { why: 'closed and resting', inFlight: false, statusKey: 'ready', closed: true },
  { why: 'starting is not working', inFlight: false, statusKey: 'starting', closed: false },
  { why: 'blocked is not working', inFlight: false, statusKey: 'blocked', closed: false },
];

// ---------------------------------------------------------------------------
// CLIENT_ID_RE — what the server will accept as an idempotency key
// ---------------------------------------------------------------------------

const CLIENT_IDS: { why: string; id: string }[] = [
  { why: 'a UUID', id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
  { why: 'a cuid', id: 'clg2h7x9k0000qw3f8v2n1r5p' },
  { why: 'the <install>:<seq> shape the iOS outbox will use', id: 'A1B2C3D4-E5F6:00000042' },
  { why: 'a dot and an underscore are both in', id: 'ios.outbox_7' },
  { why: 'exactly 128 characters', id: 'a'.repeat(128) },
  { why: '129 is one too many', id: 'a'.repeat(129) },
  { why: 'empty is refused — the length floor is 1', id: '' },
  { why: 'a slash is not in the charset', id: 'ios/7' },
  { why: 'a space is not', id: 'ios 7' },
  { why: 'a NUL is not — that is the byte Postgres refuses', id: 'ios\u00007' },
  { why: 'a Chinese character is not', id: '\u4f1a\u8bdd1' },
  { why: 'an emoji is not', id: 'ios\u{1F600}' },
  { why: 'a newline is not — and the anchors must be ^$ and not \\A\\z', id: 'ios\n7' },
  { why: 'a leading newline, same reason', id: '\nios' },
  // JS `$` (no /m) means END OF INPUT. ICU's `$` — what NSRegularExpression
  // is — matches before a FINAL line terminator as well, so a port that
  // reaches for the platform regex accepts this id and the server does not.
  { why: 'a TRAILING newline is refused: JS $ is end-of-input, ICU $ is not', id: 'ios7\n' },
  { why: 'trailing CRLF, same trap', id: 'ios7\r\n' },
];

function buildFixture() {
  return {
    queueLimit: QUEUE_LIMIT,
    deliveryGraceMs: DELIVERY_GRACE_MS,
    clientIdPattern: CLIENT_ID_RE.source,
    landed: LANDED.map((c) => ({
      ...c,
      // The ids left standing, in order — the whole answer, since dropLanded is
      // a filter and never reorders or rewrites.
      kept: dropLanded(c.optimistic, c.real).map((o) => o.id),
    })),
    placeholders: PLACEHOLDERS.map((c) => ({ ...c, expected: composerPlaceholder(c.face) })),
    canSend: CAN_SEND.map((c) => ({ ...c, expected: composerCanSend(c.input) })),
    flight: FLIGHT.map((c) => ({ ...c, expected: turnInFlight(c.input) })),
    stop: STOP.map((c) => ({ ...c, expected: stopPill(c) })),
    clientIds: CLIENT_IDS.map((c) => ({ ...c, ok: CLIENT_ID_RE.test(c.id) })),
  };
}

const out = join(REPO_ROOT, FIXTURE_JSON);
mkdirSync(dirname(out), { recursive: true });
const f = buildFixture();
writeFileSync(out, JSON.stringify(f, null, 2) + '\n');
console.log(
  `wrote      ${FIXTURE_JSON}  (${f.landed.length} landed, ${f.placeholders.length} placeholders, ` +
    `${f.canSend.length} canSend, ${f.flight.length} flight, ${f.stop.length} stop, ${f.clientIds.length} clientIds)`,
);
