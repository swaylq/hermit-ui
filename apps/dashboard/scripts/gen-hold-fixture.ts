/**
 * Renders `apps/ios/tools/fixtures/hold-cases.json` — the answers the WEB's own
 * mic slot, press-and-hold gesture and dictation text give today, for the Swift
 * port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:hold-fixture
 *
 * Four modules, one table, because on the phone they are one feature: the slot
 * right of the box (`hold-core.micSlot`), the gesture that starts a run
 * (`hold-core.holdBailed` / `holdZoneAt` / `holdPressLayer`), the geometry the
 * overlay is cut from (`hold-core.midAt` and the radii), and what the socket's
 * frames mean (`asr-reduce.asrStep`, `dictation-text.foldTail` /
 * `replaceTail` / `joinSegments` / `worthRefining`).
 *
 * The parts worth a table rather than a reading:
 *
 *   · `holdZoneAt` has FIVE ways to answer "cancel" and they are not
 *     interchangeable — displacement, or the hit box, but only once the finger
 *     has travelled `PILL_MIN_PX`, and left is tested first.
 *   · `micSlot` reads six flags and its `none` answer is reachable from two
 *     directions that look nothing alike.
 *   · `foldTail` rebases when the user typed under it; `replaceTail`, which
 *     looks identical, DROPS. Getting that pair backwards silently eats text.
 *   · `asrStep`'s corrections arrive out of order and are addressed by id. A
 *     port that patches by offset passes every in-order case.
 *
 * `apps/ios/tools/hold-fixture.sh` runs the Swift side over the same table, so a
 * red line there is always two implementations disagreeing, never an
 * implementation disagreeing with a test author.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  BAIL_PX, BAND, CAP, DOME_APEX, DROP, ENTER_MS, HOLD_AUTH_HINT, HOLD_AUTH_LABEL,
  HOLD_CANCEL_LABEL, HOLD_EDIT_LABEL, HOLD_MS, LABEL_D, LEAVE_MS, PILL_BOTTOM,
  PILL_GUTTER, PILL_HEIGHT, PILL_MIN_PX, R_DOME, R_MID, R_OUT, SLIDE_PX, ZONE_H,
  holdBailed, holdBlobMoving, holdCancelling, holdClock, holdHitBoxes,
  holdPressLayer, holdSurfaceLabel, holdZoneAt, micSlot, micSlotLabel, midAt,
  type HoldPhase, type HoldRect, type HoldZone,
} from '../src/components/chat/hold-core';
import { asrInitial, asrState, asrStep } from '../src/lib/asr-reduce';
import { foldTail, joinSegments, newClaim, replaceTail, worthRefining } from '../src/lib/dictation-text';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_JSON = 'apps/ios/tools/fixtures/hold-cases.json';

// ---------------------------------------------------------------------------
// The gesture
// ---------------------------------------------------------------------------

const BAIL_CASES = [
  { why: 'dead still', dx: 0, dy: 0 },
  { why: 'a fingertip of tremor', dx: 3, dy: 4 },
  { why: 'exactly BAIL_PX away — still a press', dx: 10, dy: 0 },
  { why: 'exactly BAIL_PX away, diagonally', dx: 6, dy: 8 },
  { why: 'one pixel past it', dx: 10.01, dy: 0 },
  { why: 'a scroll passing through', dx: 0, dy: -40 },
  { why: 'a scroll the other way', dx: 0, dy: 40 },
  { why: 'backwards counts the same', dx: -11, dy: 0 },
];
const bail = BAIL_CASES.map((c) => ({ ...c, expected: holdBailed(c.dx, c.dy) }));

// A 393×852 screen — the one the radii were measured on.
const W = 393;
const H = 852;
const boxes = holdHitBoxes(W, H);
const NO_BOX: { cancel: HoldRect | null; edit: HoldRect | null } = { cancel: null, edit: null };

type ZoneCase = {
  why: string;
  dx: number; dy: number; x: number; y: number;
  cancel: HoldRect | null; edit: HoldRect | null;
};

// The two hit boxes on that screen: y from 647 to 747, cancel x ≤ 181.5, edit x ≥ 211.5.
const ZONE_CASES: ZoneCase[] = [
  { why: 'has not moved', dx: 0, dy: 0, x: W / 2, y: 700, ...boxes },
  { why: 'drifted a little left, nowhere near SLIDE_PX', dx: -20, dy: 0, x: 176, y: 500, ...boxes },
  { why: 'exactly SLIDE_PX left — cancel', dx: -64, dy: 0, x: 132, y: 500, ...boxes },
  { why: 'one short of SLIDE_PX left, and not over a box', dx: -63.9, dy: 0, x: 132, y: 500, ...boxes },
  { why: 'exactly SLIDE_PX right — edit', dx: 64, dy: 0, x: 260, y: 500, ...boxes },
  { why: 'one short of SLIDE_PX right', dx: 63.9, dy: 0, x: 260, y: 500, ...boxes },
  { why: 'way left', dx: -200, dy: 30, x: 20, y: 700, ...boxes },
  { why: 'way right', dx: 200, dy: 30, x: 380, y: 700, ...boxes },
  {
    why: 'inside the cancel box, travelled past PILL_MIN_PX but under SLIDE_PX',
    dx: -30, dy: 20, x: 100, y: 700, ...boxes,
  },
  {
    why: 'inside the cancel box but has barely moved — the box stays off',
    dx: -10, dy: 10, x: 100, y: 700, ...boxes,
  },
  {
    why: 'exactly PILL_MIN_PX of travel is NOT travelled',
    dx: -24, dy: 0, x: 100, y: 700, ...boxes,
  },
  {
    why: 'a hair past PILL_MIN_PX, over the cancel box',
    dx: -24.1, dy: 0, x: 100, y: 700, ...boxes,
  },
  {
    why: 'inside the edit box, small displacement',
    dx: 30, dy: 20, x: 300, y: 700, ...boxes,
  },
  {
    why: 'in the gutter between the boxes — neither',
    dx: 30, dy: 20, x: W / 2, y: 700, ...boxes,
  },
  {
    why: 'on the cancel box right edge (inclusive)',
    dx: -30, dy: 0, x: W / 2 - PILL_GUTTER, y: 700, ...boxes,
  },
  {
    why: 'a pixel past the cancel box right edge',
    dx: -30, dy: 0, x: W / 2 - PILL_GUTTER + 1, y: 700, ...boxes,
  },
  {
    why: 'on the boxes top edge (inclusive)',
    dx: -30, dy: 0, x: 100, y: H - PILL_BOTTOM - PILL_HEIGHT, ...boxes,
  },
  {
    why: 'a pixel above the boxes',
    dx: -30, dy: 0, x: 100, y: H - PILL_BOTTOM - PILL_HEIGHT - 1, ...boxes,
  },
  {
    why: 'below the boxes, in the corner under cancel',
    dx: -30, dy: 60, x: 40, y: H - 10, ...boxes,
  },
  {
    why: 'slid far left AND standing on the edit box — left is tested first',
    dx: -80, dy: 0, x: 300, y: 700, ...boxes,
  },
  { why: 'no boxes yet, displacement still decides', dx: -80, dy: 0, x: 40, y: 700, ...NO_BOX },
  { why: 'no boxes, inside where cancel would be', dx: -30, dy: 0, x: 100, y: 700, ...NO_BOX },
];
const zones = ZONE_CASES.map((c) => ({
  ...c,
  expected: holdZoneAt(c) as HoldZone,
}));

// ---------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------

const MID_AT = [0, CAP, 60, LABEL_D, 150, 200, R_MID].map((d) => ({ d, expected: midAt(d) }));

const HIT_BOXES = [
  { w: 393, h: 852 },   // iPhone 17 / 16 / 15
  { w: 320, h: 568 },   // the smallest thing that still runs iOS 17
  { w: 430, h: 932 },   // Pro Max
  { w: 834, h: 1194 },  // an iPad, where the arcs run off the sides
].map((v) => ({ ...v, expected: holdHitBoxes(v.w, v.h) }));

// ---------------------------------------------------------------------------
// What the overlay says
// ---------------------------------------------------------------------------

const PHASES: HoldPhase[] = ['auth', 'listening', 'finishing'];
const ZONES: HoldZone[] = ['send', 'cancel', 'edit'];

const surface = PHASES.map((phase) => ({ phase, expected: holdSurfaceLabel(phase) }));
const cancelling = ZONES.flatMap((zone) =>
  PHASES.map((phase) => ({ zone, phase, expected: holdCancelling(zone, phase) })));
const blob = [true, false].flatMap((open) =>
  ZONES.flatMap((zone) => PHASES.map((phase) => ({ open, zone, phase, expected: holdBlobMoving(open, zone, phase) }))));
const clock = [0, 1, 9, 59, 60, 61, 599, 600, 3599, 3600, 3661].map((s) => ({ s, expected: holdClock(s) }));

// ---------------------------------------------------------------------------
// The slot
// ---------------------------------------------------------------------------

type SlotIn = Parameters<typeof micSlot>[0];
const SLOT_CASES: { why: string; input: SlotIn }[] = [];
for (const dictating of [false, true]) {
  for (const draftLength of [0, 7]) {
    for (const canDictate of [true, false]) {
      for (const disabled of [false, true]) {
        for (const awaitingInput of [false, true]) {
          for (const micArming of [false, true]) {
            SLOT_CASES.push({
              why: `dictating=${dictating} draft=${draftLength} canDictate=${canDictate} disabled=${disabled} awaiting=${awaitingInput} arming=${micArming}`,
              input: { dictating, draftLength, canDictate, disabled, awaitingInput, micArming },
            });
          }
        }
      }
    }
  }
}
const slots = SLOT_CASES.map((c) => ({ ...c, expected: micSlot(c.input) }));
const slotLabels = [false, true].map((d) => ({ dictating: d, expected: micSlotLabel(d) }));

type LayerIn = Parameters<typeof holdPressLayer>[0];
const LAYER_CASES: { why: string; input: LayerIn }[] = [
  {
    why: 'the resting state on a phone: empty, unfocused, idle — the layer is on',
    input: { touch: true, canDictate: true, disabled: false, awaitingInput: false, dictating: false, draftLength: 0, focused: false, gestureLive: false },
  },
  {
    why: 'a desktop never holds the box',
    input: { touch: false, canDictate: true, disabled: false, awaitingInput: false, dictating: false, draftLength: 0, focused: false, gestureLive: false },
  },
  {
    why: 'the caret is in the box — it is an ordinary textarea again',
    input: { touch: true, canDictate: true, disabled: false, awaitingInput: false, dictating: false, draftLength: 0, focused: true, gestureLive: false },
  },
  {
    why: 'there is a draft',
    input: { touch: true, canDictate: true, disabled: false, awaitingInput: false, dictating: false, draftLength: 3, focused: false, gestureLive: false },
  },
  {
    why: 'no dictation handler at all',
    input: { touch: true, canDictate: false, disabled: false, awaitingInput: false, dictating: false, draftLength: 0, focused: false, gestureLive: false },
  },
  {
    why: 'session closed',
    input: { touch: true, canDictate: true, disabled: true, awaitingInput: false, dictating: false, draftLength: 0, focused: false, gestureLive: false },
  },
  {
    why: 'a card upstream is waiting on a tap',
    input: { touch: true, canDictate: true, disabled: false, awaitingInput: true, dictating: false, draftLength: 0, focused: false, gestureLive: false },
  },
  {
    why: 'a hands-free run is live — no hold layer over a box being written into',
    input: { touch: true, canDictate: true, disabled: false, awaitingInput: false, dictating: true, draftLength: 0, focused: false, gestureLive: false },
  },
  {
    why: 'MID-GESTURE: every idle input has gone false and the layer must stay',
    input: { touch: true, canDictate: true, disabled: false, awaitingInput: false, dictating: true, draftLength: 12, focused: false, gestureLive: true },
  },
  {
    why: 'mid-gesture on a desktop is impossible, but the flag still wins',
    input: { touch: false, canDictate: false, disabled: true, awaitingInput: true, dictating: true, draftLength: 12, focused: true, gestureLive: true },
  },
];
const layers = LAYER_CASES.map((c) => ({ ...c, expected: holdPressLayer(c.input) }));

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

const JOIN_CASES: { why: string; texts: string[] }[] = [
  { why: 'nothing', texts: [] },
  { why: 'one sentence', texts: ['把隧道重启一下。'] },
  { why: 'Chinese sentences abut — no space', texts: ['把隧道重启一下。', '然后看看日志。'] },
  { why: 'empty segments are skipped, not joined around', texts: ['第一句。', '', '第三句。'] },
  { why: 'the Latin seam gets a space', texts: ['restart', 'then check'] },
  { why: 'digits count as word characters on both sides', texts: ['port 8080', '3 times'] },
  { why: 'a seam that is punctuation on the left needs no space', texts: ['restart.', 'then check'] },
  { why: 'a seam that is punctuation on the right needs no space', texts: ['restart', '. then'] },
  { why: 'Chinese then Latin', texts: ['重启', 'nginx'] },
  { why: 'Latin then Chinese', texts: ['nginx', '重启'] },
  { why: 'a leading empty segment does not earn a space', texts: ['', 'restart'] },
  { why: 'trailing empty', texts: ['restart', ''] },
];
const joins = JOIN_CASES.map((c) => ({ ...c, expected: joinSegments(c.texts) }));

/** A claim, as a table row: what the run has put in the draft so far. */
type ClaimJSON = { base: string | null; rendered: string };
const claim = (base: string | null, rendered: string): ClaimJSON => ({ base, rendered });

const FOLD_CASES: { why: string; claim: ClaimJSON; draft: string; tail: string }[] = [
  { why: 'first words into an empty box', claim: claim(null, ''), draft: '', tail: '你好' },
  { why: 'first words into a box that already had typing — a space is inserted', claim: claim(null, ''), draft: '备注', tail: '你好' },
  { why: 'nothing dictated and nothing to dictate — the draft is left alone', claim: claim(null, ''), draft: '手打的', tail: '' },
  { why: 'the tail grows, claim intact', claim: claim('', '你好'), draft: '你好', tail: '你好世界' },
  { why: 'the tail shrinks to nothing — the base comes back, trimmed', claim: claim('备注 ', '备注 你好'), draft: '备注 你好', tail: '' },
  { why: 'the user typed under the run: THEIR text becomes the new base', claim: claim('', '你好'), draft: '你好 手打', tail: '你好世界' },
  { why: 'the user emptied the box mid-run', claim: claim('', '你好'), draft: '', tail: '你好世界' },
  { why: 'trailing whitespace in the interfered draft is folded into the separator', claim: claim('', '你好'), draft: '手打的   ', tail: '继续' },
  { why: 'base with no trailing space stays exactly as stored', claim: claim('前言', '前言你好'), draft: '前言你好', tail: '你好吗' },
];
const folds = FOLD_CASES.map((c) => {
  const got = foldTail({ base: c.claim.base, rendered: c.claim.rendered }, c.draft, c.tail);
  return { ...c, expected: { draft: got.draft, claim: { base: got.claim.base, rendered: got.claim.rendered } } };
});

const REPLACE_CASES: { why: string; claim: ClaimJSON; draft: string; tail: string }[] = [
  { why: 'the whole-passage correction lands', claim: claim('', '你好世界'), draft: '你好世界', tail: '你好，世界。' },
  { why: 'with a base in front of it', claim: claim('备注 ', '备注 你好世界'), draft: '备注 你好世界', tail: '你好，世界。' },
  { why: 'an empty correction gives the base back, trimmed', claim: claim('备注 ', '备注 你好'), draft: '备注 你好', tail: '' },
  { why: 'the run never wrote anything — nothing to replace', claim: claim(null, ''), draft: '手打的', tail: '你好，世界。' },
  { why: 'the draft moved under it: STALE, and dropped (this is where foldTail would append)', claim: claim('', '你好世界'), draft: '你好世界 手打', tail: '你好，世界。' },
];
const replaces = REPLACE_CASES.map((c) => {
  const got = replaceTail({ base: c.claim.base, rendered: c.claim.rendered }, c.draft, c.tail);
  return { ...c, expected: { draft: got.draft, claim: { base: got.claim.base, rendered: got.claim.rendered }, applied: got.applied } };
});

const REFINE_CASES = [
  '',
  '继续',
  '把隧道重启一下',
  '把隧道重启一下。',
  '把隧道重启一下。然后看看日志。',
  '短。短。',
  'a. b. c',
  '把 zhinan-main 上的隧道重启一下，然后看一眼 pm2 的日志有没有报错',
  '   把隧道重启一下。然后看看日志。   ',
  '一二三四五六七八九十一二三四五',
  '一二三四五六七八九十一二三四五六',
  // Two passages where JavaScript's `.length` and a port's idea of a character
  // disagree: eight emoji are 16 UTF-16 units and eight Characters, eighteen are
  // 36 and eighteen. Nothing anyone dictates looks like this, and that is not
  // the point — the point is that the two counts are the SAME for every CJK and
  // Latin string in the table above, so a port that counts graphemes passes all
  // of them. (The Swift side answers with `utf16.count` because the web's
  // `.length` is what the threshold was chosen against.)
  '🙂🙂🙂🙂🙂🙂🙂🙂。。',
  '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂',
].map((passage) => ({ passage, expected: worthRefining(passage) }));

const newClaimShape = newClaim();

// ---------------------------------------------------------------------------
// The socket's frames
// ---------------------------------------------------------------------------

/**
 * Each case is a SEQUENCE, because that is the only way the out-of-order
 * correction is a case at all: the state after every frame is recorded, so a
 * port that gets frame 4 right by getting frames 1–3 wrong still goes red.
 */
const ASR_SCRIPTS: { why: string; frames: string[] }[] = [
  { why: 'nothing yet', frames: [] },
  {
    why: 'the ordinary run: ready, a partial that rewrites itself, a final, its polish, done',
    frames: [
      '{"type":"ready"}',
      '{"type":"partial","text":"把"}',
      '{"type":"partial","text":"把隧道重"}',
      '{"type":"final","segId":0,"text":"把隧道重启一下"}',
      '{"type":"polished","segId":0,"text":"把隧道重启一下。"}',
      '{"type":"done"}',
    ],
  },
  {
    why: 'corrections come back OUT OF ORDER — segment 1 before segment 0',
    frames: [
      '{"type":"final","segId":0,"text":"第一句"}',
      '{"type":"final","segId":1,"text":"第二句"}',
      '{"type":"polished","segId":1,"text":"第二句。"}',
      '{"type":"polished","segId":0,"text":"第一句。"}',
    ],
  },
  {
    why: 'a correction for a sentence that was never opened is ignored',
    frames: ['{"type":"final","segId":0,"text":"第一句"}', '{"type":"polished","segId":9,"text":"凭空"}'],
  },
  {
    why: 'ids need not start at 0 or be contiguous',
    frames: [
      '{"type":"final","segId":7,"text":"seven"}',
      '{"type":"final","segId":11,"text":"eleven"}',
      '{"type":"polished","segId":7,"text":"Seven."}',
    ],
  },
  {
    why: 'a final with no segId is dropped — nothing could ever correct it',
    frames: ['{"type":"final","text":"无主的一句"}', '{"type":"partial","text":"下一句"}'],
  },
  {
    why: 'a polish that came back empty keeps the sentence it was correcting',
    frames: ['{"type":"final","segId":0,"text":"原句"}', '{"type":"polished","segId":0}'],
  },
  {
    why: 'a final with no text opens an empty sentence, and it still holds its slot',
    frames: ['{"type":"final","segId":0}', '{"type":"final","segId":1,"text":"第二句"}'],
  },
  {
    why: 'done clears every outstanding correction and the partial',
    frames: [
      '{"type":"final","segId":0,"text":"第一句"}',
      '{"type":"partial","text":"没说完的"}',
      '{"type":"done"}',
    ],
  },
  {
    why: 'a fatal error, and its message',
    frames: ['{"type":"error","fatal":true,"message":"Too many requests"}'],
  },
  { why: 'a fatal error with no message has a default', frames: ['{"type":"error","fatal":true}'] },
  { why: 'a non-fatal error is not a failure', frames: ['{"type":"error","message":"hiccup"}'] },
  { why: 'garbage on the wire changes nothing', frames: ['not json at all', '{"type":"partial","text":"ok"}'] },
  { why: 'a frame type this client has never heard of', frames: ['{"type":"vibes","text":"?"}'] },
  { why: 'valid JSON that is not an object', frames: ['42', '"hello"', 'null'] },
  {
    why: 'the same partial twice says nothing new — the second frame changes nothing',
    frames: ['{"type":"partial","text":"把隧道"}', '{"type":"partial","text":"把隧道"}'],
  },
  {
    why: 'a correction repeated says nothing new either',
    frames: [
      '{"type":"final","segId":0,"text":"原句"}',
      '{"type":"polished","segId":0,"text":"原句。"}',
      '{"type":"polished","segId":0,"text":"原句。"}',
    ],
  },
  {
    why: 'done on a run that already settled: the effect fires, the model does not move',
    frames: ['{"type":"final","segId":0,"text":"一句"}', '{"type":"done"}', '{"type":"done"}'],
  },
  {
    why: 'a partial that empties itself IS news',
    frames: ['{"type":"partial","text":"半句"}', '{"type":"partial","text":""}'],
  },
  {
    why: 'a partial after a final, then another final: the Latin seam gets its space',
    frames: [
      '{"type":"final","segId":0,"text":"restart"}',
      '{"type":"partial","text":"then"}',
      '{"type":"final","segId":1,"text":"then check"}',
    ],
  },
];
const asr = ASR_SCRIPTS.map((s) => {
  let m = asrInitial();
  const steps = s.frames.map((raw) => {
    const got = asrStep(m, raw);
    const changed = got.model !== m;
    m = got.model;
    const st = asrState(m);
    return { raw, changed, effect: got.effect, state: st };
  });
  return { why: s.why, steps };
});

// ---------------------------------------------------------------------------

const out = {
  thresholds: { holdMs: HOLD_MS, bailPx: BAIL_PX, slidePx: SLIDE_PX, pillMinPx: PILL_MIN_PX },
  geometry: {
    drop: DROP, rDome: R_DOME, rOut: R_OUT, band: BAND, cap: CAP, rMid: R_MID,
    zoneH: ZONE_H, labelD: LABEL_D, domeApex: DOME_APEX,
    pillBottom: PILL_BOTTOM, pillHeight: PILL_HEIGHT, pillGutter: PILL_GUTTER,
    enterMs: ENTER_MS, leaveMs: LEAVE_MS,
  },
  labels: {
    cancel: HOLD_CANCEL_LABEL, edit: HOLD_EDIT_LABEL,
    auth: HOLD_AUTH_LABEL, authHint: HOLD_AUTH_HINT,
  },
  newClaim: newClaimShape,
  bail, zones, midAt: MID_AT, hitBoxes: HIT_BOXES,
  surface, cancelling, blob, clock,
  slots, slotLabels, layers,
  joins, folds, replaces, refine: REFINE_CASES,
  asr,
};

const path = join(REPO_ROOT, FIXTURE_JSON);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
const count =
  bail.length + zones.length + MID_AT.length + HIT_BOXES.length + surface.length +
  cancelling.length + blob.length + clock.length + slots.length + slotLabels.length +
  layers.length + joins.length + folds.length + replaces.length + REFINE_CASES.length +
  asr.reduce((n, s) => n + s.steps.length + 1, 0);
console.log(`wrote ${FIXTURE_JSON} — ${count} cases`);
