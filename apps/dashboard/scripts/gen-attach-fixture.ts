/**
 * Renders `apps/ios/tools/fixtures/attach-cases.json` — the answers the WEB's
 * own attachment logic gives today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:attach-fixture
 *
 * The `+` button looks like a file picker and is in fact eight decisions, most
 * of which are only interesting in the case that goes wrong:
 *
 *   · `getExt` takes the LAST dot anywhere, so `.bashrc` reads as `bashrc` —
 *     where every path-extension helper in Foundation and node answers `''`.
 *   · `occupiedSlots` does NOT count an `error` chip, so a rejected file must
 *     not cost the reader an image.
 *   · `admitFiles` applies the two caps INDEPENDENTLY and IN ORDER: thirty
 *     photos and one PDF keeps twenty photos and the PDF.
 *   · `readyLabel`'s `if (a.width && a.height)` is falsy for ZERO as well as
 *     null, so a decode that produced 0×0 says `image`.
 *   · `chipSubLabel` cuts an error at 40 UTF-16 code units, not 40 characters.
 *
 * The table is produced by RUNNING those functions, and
 * `apps/ios/tools/attach-fixture.sh` runs the Swift side over the same table. A
 * red line there is always two implementations disagreeing, never an
 * implementation disagreeing with a test author.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  CAPS_SEPARATOR,
  FILE_ACCEPT,
  MAX_FILES,
  MAX_IMAGES,
  SAFE_FILE_EXTS,
  admitFiles,
  attachName,
  capsCaption,
  chipSubLabel,
  getExt,
  isSafeFileName,
  occupiedSlots,
  readyLabel,
  unsupportedTypeError,
  type SlotUse,
} from '../src/components/chat/attach-core';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_JSON = 'apps/ios/tools/fixtures/attach-cases.json';

// ---------------------------------------------------------------------------
// getExt / isSafeFileName / unsupportedTypeError — one table, three answers
// ---------------------------------------------------------------------------

const NAMES: { why: string; name: string }[] = [
  { why: 'ordinary', name: 'report.pdf' },
  { why: 'uppercase extension is lowercased', name: 'REPORT.PDF' },
  { why: 'two dots — the LAST one wins', name: 'archive.tar.gz' },
  { why: 'no dot at all', name: 'Makefile' },
  { why: 'a dotfile: the leading dot IS the last dot, so the whole name is the ext', name: '.bashrc' },
  { why: 'a trailing dot leaves an empty extension', name: 'weird.' },
  { why: 'an extension nobody allows', name: 'payload.exe' },
  { why: 'a path-looking name — no directory handling anywhere in here', name: 'src/lib/util.ts' },
  { why: 'empty', name: '' },
  { why: 'unicode name, allowed extension', name: '会议纪要.md' },
  { why: 'unicode extension', name: 'file.文档' },
  { why: 'a space before the extension', name: 'my file.txt' },
  { why: 'the dot is the whole name', name: '.' },
  { why: 'an allowed archive', name: 'bundle.ZIP' },
  { why: 'video', name: 'clip.mov' },
];

const names = NAMES.map((c) => ({
  ...c,
  ext: getExt(c.name),
  safe: isSafeFileName(c.name),
  error: unsupportedTypeError(c.name),
  asImage: attachName(c.name, true),
  asFile: attachName(c.name, false),
}));

// ---------------------------------------------------------------------------
// occupiedSlots + admitFiles — the caps
// ---------------------------------------------------------------------------

const slot = (kind: SlotUse['kind'], isImage: boolean): SlotUse => ({ kind, isImage });
const many = (n: number, kind: SlotUse['kind'], isImage: boolean) =>
  Array.from({ length: n }, () => slot(kind, isImage));

type AdmitCase = { why: string; incoming: boolean[]; existing: SlotUse[] };

const ADMIT: AdmitCase[] = [
  { why: 'nothing anywhere', incoming: [], existing: [] },
  { why: 'one image into an empty composer', incoming: [true], existing: [] },
  { why: 'one file into an empty composer', incoming: [false], existing: [] },
  {
    why: 'an error chip holds NO slot — a rejected file must not cost an image',
    incoming: many(MAX_IMAGES, 'ready', true).map(() => true),
    existing: many(MAX_IMAGES, 'error', true),
  },
  {
    why: 'uploading chips DO hold a slot',
    incoming: [true, true],
    existing: [...many(MAX_IMAGES - 1, 'uploading', true)],
  },
  {
    why: 'the image cap, exactly reached',
    incoming: Array.from({ length: MAX_IMAGES }, () => true),
    existing: [],
  },
  {
    why: 'one image over the cap',
    incoming: Array.from({ length: MAX_IMAGES + 1 }, () => true),
    existing: [],
  },
  {
    why: 'ten over — plural, and the count is of the DROPPED ones',
    incoming: Array.from({ length: MAX_IMAGES + 10 }, () => true),
    existing: [],
  },
  {
    why: 'one file over the cap',
    incoming: Array.from({ length: MAX_FILES + 1 }, () => false),
    existing: [],
  },
  {
    why: 'both over: two clauses joined with "and", images first',
    incoming: [
      ...Array.from({ length: MAX_IMAGES + 2 }, () => true),
      ...Array.from({ length: MAX_FILES + 3 }, () => false),
    ],
    existing: [],
  },
  {
    why: 'the budgets are INDEPENDENT — a full image list still takes the pdf',
    incoming: [true, false],
    existing: many(MAX_IMAGES, 'ready', true),
  },
  {
    why: 'order is kept: the first twenty photos, not an arbitrary twenty',
    incoming: [...Array.from({ length: 25 }, () => true), false],
    existing: [],
  },
  {
    why: 'already over the cap (a stale state): no slots, nothing accepted',
    incoming: [true],
    existing: many(MAX_IMAGES + 3, 'ready', true),
  },
  {
    why: 'a mixed existing list',
    incoming: [true, false, true],
    existing: [slot('ready', true), slot('uploading', false), slot('error', false), slot('ready', false)],
  },
];

const admit = ADMIT.map((c) => ({
  ...c,
  occupied: occupiedSlots(c.existing),
  expected: admitFiles(c.incoming.map((isImage) => ({ isImage })), c.existing),
}));

// ---------------------------------------------------------------------------
// capsCaption
// ---------------------------------------------------------------------------

const CAPS: [number, number][] = [
  [0, 0], [1, 0], [0, 1], [3, 2],
  [MAX_IMAGES, 0], [MAX_IMAGES, MAX_FILES], [0, MAX_FILES],
  [MAX_IMAGES + 1, MAX_FILES + 1],
];
const caps = CAPS.map(([images, files]) => ({ images, files, expected: capsCaption(images, files) }));

// ---------------------------------------------------------------------------
// readyLabel / chipSubLabel
// ---------------------------------------------------------------------------

type LabelCase = {
  why: string;
  isImage: boolean;
  name: string;
  mimeType: string;
  width: number | null;
  height: number | null;
};

const LABELS: LabelCase[] = [
  { why: 'an image with dimensions', isImage: true, name: 'shot.png', mimeType: 'image/png', width: 1290, height: 2796 },
  { why: 'an image the server could not measure', isImage: true, name: 'shot.png', mimeType: 'image/png', width: null, height: null },
  { why: 'half-measured is not measured', isImage: true, name: 'shot.png', mimeType: 'image/png', width: 100, height: null },
  { why: 'ZERO is falsy on the web — a failed decode says "image", not 0×0', isImage: true, name: 'shot.png', mimeType: 'image/png', width: 0, height: 0 },
  { why: 'a file with a usable mime subtype', isImage: false, name: 'report.pdf', mimeType: 'application/pdf', width: null, height: null },
  { why: 'octet-stream is refused, so the NAME answers', isImage: false, name: 'notes.md', mimeType: 'application/octet-stream', width: null, height: null },
  { why: 'octet-stream and no dot in the name', isImage: false, name: 'Makefile', mimeType: 'application/octet-stream', width: null, height: null },
  { why: 'no slash in the mime type at all', isImage: false, name: 'x.zip', mimeType: 'zip', width: null, height: null },
  { why: 'nothing after the slash', isImage: false, name: 'x.zip', mimeType: 'application/', width: null, height: null },
  { why: 'the name ends in a dot — the last segment is empty', isImage: false, name: 'weird.', mimeType: 'application/octet-stream', width: null, height: null },
  { why: 'the label is NOT lowercased, unlike the allowlist lookup', isImage: false, name: 'DECK.PPTX', mimeType: 'application/octet-stream', width: null, height: null },
  { why: 'a non-image that DOES carry dimensions still prints them', isImage: false, name: 'clip.mov', mimeType: 'video/quicktime', width: 1920, height: 1080 },
  { why: 'a mime type with two slashes', isImage: false, name: 'x.txt', mimeType: 'a/b/c', width: null, height: null },
];

const labels = LABELS.map((c) => ({
  ...c,
  expected: readyLabel(c),
  chip: chipSubLabel({ kind: 'ready', ...c }),
}));

const ERRORS: { why: string; error: string }[] = [
  { why: 'short', error: 'upload failed (413)' },
  { why: 'exactly forty', error: 'x'.repeat(40) },
  { why: 'forty-one — cut', error: 'y'.repeat(41) },
  { why: 'a long server sentence', error: 'upload failed (415): {"error":"unsupported file type (.exe)"}' },
  { why: 'CJK past the cut — 40 UTF-16 units is 40 of these', error: '上传失败'.repeat(15) },
  {
    // The discriminating case for the port. A decomposed e-acute is ONE
    // Character in Swift and TWO UTF-16 code units in JavaScript, so a cut that
    // counts characters keeps the accent and a cut that counts code units drops
    // it. Both results are well-formed strings, which is what makes this a
    // usable fixture row where a surrogate pair would not be.
    why: 'a combining mark straddles the cut — 40 units keeps the base and drops the accent',
    error: 'a'.repeat(39) + 'e\u0301' + 'z'.repeat(5),
  },
  // NOT here, and it was tried: an error string whose 40th UTF-16 unit is the
  // HIGH half of a surrogate pair. `slice(0, 40)` leaves a lone surrogate,
  // `JSON.stringify` escapes it as a bare \ud83d, and Foundation's JSONDecoder
  // then refuses the WHOLE FILE ("Missing low code point in surrogate pair") —
  // so the case cannot be carried in a shared table at all, and carrying it
  // costs every other case in the file. The port cuts by UTF-16 unit, which is
  // what the web counts; nobody's chip is 40 units of emoji.
  { why: 'empty', error: '' },
];
const errors = ERRORS.map((c) => ({ ...c, expected: chipSubLabel({ kind: 'error', error: c.error }) }));

// ---------------------------------------------------------------------------

const out = {
  maxImages: MAX_IMAGES,
  maxFiles: MAX_FILES,
  capsSeparator: CAPS_SEPARATOR,
  safeFileExts: [...SAFE_FILE_EXTS],
  fileAccept: FILE_ACCEPT,
  uploadingLabel: chipSubLabel({ kind: 'uploading' }),
  names,
  admit,
  caps,
  labels,
  errors,
};

const path = join(REPO_ROOT, FIXTURE_JSON);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
const count = names.length * 5 + admit.length * 2 + caps.length + labels.length * 2 + errors.length + 4;
console.log(`wrote ${FIXTURE_JSON} — ${count} checks`);
