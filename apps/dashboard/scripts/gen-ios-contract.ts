/**
 * Renders `apps/ios/Shared/WebContract.swift` from the web app.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:ios-contract
 *
 * Why this exists: the iOS app is a second implementation of the same product,
 * and a handful of the web's numbers have to be the SAME number over there —
 * the live window it asks for, the reconnect schedule, how long a Live Activity
 * may sit before the system dims it, the status colours. Every one of them was
 * copied by hand, and one of them had already drifted by the time this was
 * written (the working-state staleness was 10 minutes on the phone against the
 * server's 15, so a healthy long tool call dimmed the Lock Screen for five
 * minutes and then got refreshed back).
 *
 * A number that lives in two files drifts. So it lives in one, and the other is
 * generated from it — and `src/lib/ios-contract.test.ts` fails while the checked-in
 * Swift is stale, which is what makes "generated" true rather than aspirational.
 * A Swift-only change is a red test, not a surprise on someone's phone.
 *
 * The colours are not copied at all: `session-status.ts` and `ctx-bar.tsx` name
 * Tailwind classes, and this resolves those very class names through Tailwind's
 * own `theme.css` and converts the oklch to Display P3. Add a class on the web
 * and it appears here; the conversion is pinned by the test against the values
 * the file carried before it was generated.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { INITIAL_WINDOW, TIMELINE_DIGEST } from '../src/lib/chat-window';

/** Repo root, from this file's own location. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Where the rendered Swift lives, repo-relative. */
export const CONTRACT_SWIFT = 'apps/ios/Shared/WebContract.swift';

/** The web files whose numbers the phone has to agree with. */
export const SOURCES = {
  window: 'apps/dashboard/src/lib/chat-window.ts',
  stream: 'apps/dashboard/src/app/chat/page.tsx',
  liveActivity: 'apps/dashboard/src/server/push/live-activity.ts',
  statusDots: 'apps/dashboard/src/lib/session-status.ts',
  ctxBar: 'apps/dashboard/src/components/ctx-bar.tsx',
  search: 'apps/dashboard/src/lib/chat-cache/search-core.ts',
} as const;

// ---------------------------------------------------------------------------
// Reading a constant out of a source file
//
// Two of the five sources cannot simply be imported: `chat/page.tsx` is a React
// page and its two numbers are locals inside the effect that owns the stream,
// and `push/live-activity.ts` pulls in Prisma at module load. Both are read as
// text instead. That is weaker than an import — a rename breaks it — but it
// breaks LOUDLY, in the test, which is the whole point; the alternative was
// hoisting two constants out of the hottest file in the repo.
// ---------------------------------------------------------------------------

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Evaluates a numeric literal expression: digits, `_` separators, `* + - / ()`. */
function evalNumber(expr: string, where: string): number {
  const cleaned = expr.replace(/_/g, '').trim();
  if (!/^[\d\s*+\-/.()]+$/.test(cleaned)) {
    throw new Error(`${where}: not a plain numeric expression: ${expr}`);
  }
  const n = Number(new Function(`return (${cleaned});`)());
  if (!Number.isFinite(n)) throw new Error(`${where}: did not evaluate to a number: ${expr}`);
  return n;
}

/** `const NAME = <numeric expression>;` — the declaration must be unique. */
export function readNumberConst(rel: string, name: string): number {
  const src = read(rel);
  const re = new RegExp(`\\bconst ${name}\\s*=\\s*([^;\\n]+);`, 'g');
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) {
    throw new Error(`${rel}: expected exactly one \`const ${name} = …;\`, found ${hits.length}`);
  }
  return evalNumber(hits[0][1], `${rel} ${name}`);
}

/** `const NAME = [a, b, c];` — same rules, per element. */
export function readNumberArrayConst(rel: string, name: string): number[] {
  const src = read(rel);
  const re = new RegExp(`\\bconst ${name}\\s*=\\s*\\[([^\\]]*)\\];`, 'g');
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) {
    throw new Error(`${rel}: expected exactly one \`const ${name} = [ … ];\`, found ${hits.length}`);
  }
  return hits[0][1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s, i) => evalNumber(s, `${rel} ${name}[${i}]`));
}

/** Every Tailwind colour class a file names, as `family-shade`, deduped. */
export function readColorClasses(rel: string, prefixes: readonly string[]): string[] {
  const src = read(rel);
  const re = new RegExp(`['"\`](?:${prefixes.join('|')})-([a-z]+-\\d{2,3})(?:/\\d+)?['"\`]`, 'g');
  const found = [...src.matchAll(re)].map((m) => m[1]);
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Tailwind's oklch → Display P3
//
// Display P3 and not sRGB because three of these sit outside sRGB and clip
// visibly (amber-400 lands on #FFB900 with two channels pinned, which is
// flatter than the same colour in Safari on the same phone).
// ---------------------------------------------------------------------------

/** sRGB primaries → CIE XYZ (D65). */
const M_SRGB_TO_XYZ = [
  [0.4123907992659595, 0.357584339383878, 0.1804807884018343],
  [0.2126390058715104, 0.7151686787677559, 0.0721923153607337],
  [0.0193308187155918, 0.1191947797946259, 0.9505321522496608],
] as const;

/** CIE XYZ (D65) → Display P3 primaries. */
const M_XYZ_TO_P3 = [
  [2.4934969119414263, -0.9313836179191241, -0.4027107844507168],
  [-0.8294889695615747, 1.7626640603183465, 0.0236246858419436],
  [0.0358458302437845, -0.0761723892680418, 0.9568845240076871],
] as const;

function mul3(m: readonly (readonly number[])[], v: readonly number[]): number[] {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}

/** The sRGB transfer function, which Display P3 shares. */
function encodeGamma(u: number): number {
  const c = Math.min(1, Math.max(0, u));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** `oklch(82.8% 0.189 84.429)` → its three numbers, L in 0…1. */
export function parseOklch(css: string): Oklch {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css.trim());
  if (!m) throw new Error(`not an oklch() colour: ${css}`);
  const l = Number(m[1]) / (m[2] === '%' ? 100 : 1);
  return { l, c: Number(m[3]), h: Number(m[4]) };
}

/** Oklch → gamma-encoded Display P3, the three numbers SwiftUI's initialiser takes. */
export function oklchToDisplayP3({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  // Oklab → LMS → linear sRGB (Björn Ottosson's matrices).
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linearSrgb = [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
  const linearP3 = mul3(M_XYZ_TO_P3, mul3(M_SRGB_TO_XYZ, linearSrgb));
  const [r, g, bl] = linearP3.map(encodeGamma);
  return [r, g, bl];
}

/** Tailwind's own palette, read from the package the app's CSS imports. */
export function tailwindOklch(): Map<string, string> {
  const require_ = createRequire(import.meta.url);
  const css = readFileSync(require_.resolve('tailwindcss/theme.css'), 'utf8');
  const out = new Map<string, string>();
  for (const m of css.matchAll(/--color-([a-z]+-\d{2,3}):\s*(oklch\([^)]*\));/g)) {
    out.set(m[1], m[2]);
  }
  if (out.size === 0) throw new Error('tailwindcss/theme.css carried no --color-* oklch values');
  return out;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface PaletteEntry {
  /** `amber-400` */
  cls: string;
  /** `amber400` */
  swiftName: string;
  /** `oklch(82.8% 0.189 84.429)` */
  oklch: string;
  p3: [number, number, number];
}

export interface Contract {
  timelineLimit: number;
  timelineDigest: boolean;
  streamBackoffsSec: number[];
  streamIdleDeadlineSec: number;
  workingStaleSec: number;
  blockedStaleSec: number;
  lingerSec: number;
  ctxDangerPct: number;
  ctxWarnPct: number;
  snapshotStaleMs: number;
  backgroundResidentMs: number;
  snippetPad: number;
  searchPageSize: number;
  maxMatchesPerRow: number;
  palette: PaletteEntry[];
}

const SHADE = (cls: string) => Number(cls.split('-')[1]);
const FAMILY = (cls: string) => cls.split('-')[0];

export function readContract(): Contract {
  const classes = [
    ...readColorClasses(SOURCES.statusDots, ['bg']),
    ...readColorClasses(SOURCES.ctxBar, ['bg', 'text']),
  ];
  const uniq = [...new Set(classes)].sort(
    (x, y) => FAMILY(x).localeCompare(FAMILY(y)) || SHADE(x) - SHADE(y),
  );
  const theme = tailwindOklch();
  const palette: PaletteEntry[] = uniq.map((cls) => {
    const oklch = theme.get(cls);
    if (!oklch) throw new Error(`Tailwind has no --color-${cls}; is that class a typo?`);
    return {
      cls,
      swiftName: FAMILY(cls) + SHADE(cls),
      oklch,
      p3: oklchToDisplayP3(parseOklch(oklch)),
    };
  });

  const bands = [...new Set([...read(SOURCES.ctxBar).matchAll(/pct\s*>=\s*(\d+)/g)].map((m) => Number(m[1])))]
    .sort((a, b) => b - a);
  if (bands.length !== 2) {
    throw new Error(`${SOURCES.ctxBar}: expected two \`pct >= N\` bands, found ${bands.length}`);
  }

  return {
    timelineLimit: INITIAL_WINDOW,
    timelineDigest: TIMELINE_DIGEST,
    streamBackoffsSec: readNumberArrayConst(SOURCES.stream, 'BACKOFFS').map((ms) => ms / 1000),
    streamIdleDeadlineSec: readNumberConst(SOURCES.stream, 'IDLE_DEAD_MS') / 1000,
    workingStaleSec: readNumberConst(SOURCES.liveActivity, 'WORKING_STALE_MS') / 1000,
    blockedStaleSec: readNumberConst(SOURCES.liveActivity, 'BLOCKED_STALE_MS') / 1000,
    lingerSec: readNumberConst(SOURCES.liveActivity, 'LINGER_MS') / 1000,
    ctxDangerPct: bands[0],
    ctxWarnPct: bands[1],
    // Left in MILLISECONDS, unlike every duration above it. Those feed
    // TimeInterval APIs, which are seconds; these two feed the Swift port of
    // `sessionStatusView`, which is a line-for-line copy of a function whose
    // every clock is in ms. Converting here would put the one unit conversion
    // in the product inside the thing being compared against the original.
    snapshotStaleMs: readNumberConst(SOURCES.statusDots, 'SNAPSHOT_STALE_MS'),
    backgroundResidentMs: readNumberConst(SOURCES.statusDots, 'BACKGROUND_RESIDENT_MS'),
    snippetPad: readNumberConst(SOURCES.search, 'SNIPPET_PAD'),
    searchPageSize: readNumberConst(SOURCES.search, 'DEFAULT_PAGE'),
    maxMatchesPerRow: readNumberConst(SOURCES.search, 'MAX_MATCHES_PER_ROW'),
    palette,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Swift literal for a duration. Every one of these divides 1000 evenly today;
 *  a fractional one still renders correctly as a Double literal. */
const sec = (n: number) => String(n);
const chan = (n: number) => n.toFixed(4);

export function renderWebContractSwift(c: Contract): string {
  const L: string[] = [];
  L.push('// GENERATED FILE — do not edit by hand.');
  L.push('//');
  L.push('// Rendered from the web app by apps/dashboard/scripts/gen-ios-contract.ts:');
  L.push('//');
  L.push('//     pnpm --filter @hermit-ui/dashboard gen:ios-contract');
  L.push('//');
  L.push('// Everything here is a number the phone has to agree with the web on, and');
  L.push('// every one of them used to be a hand-copy. Change it where the comment says');
  L.push('// it comes from and regenerate — a Swift-only edit is reverted by the next');
  L.push('// run, and `pnpm --filter @hermit-ui/dashboard test` is red until this file');
  L.push('// matches its sources again.');
  L.push('//');
  L.push('// The names below are deliberately the WEB\'s names. Swift-side meaning');
  L.push('// (which colour is "needs you", how long a stream may sit quiet) belongs to');
  L.push('// the hand-written files that read these — StatusPalette, HermitStream,');
  L.push('// LiveActivityManager — where it can carry a comment worth reading.');
  L.push('');
  L.push('import SwiftUI');
  L.push('');
  L.push('enum WebContract {');
  L.push('');
  L.push(`    // MARK: - The live window (${SOURCES.window})`);
  L.push('');
  L.push('    /// INITIAL_WINDOW — the newest N messages, the only window the stream carries.');
  L.push(`    static let timelineLimit = ${c.timelineLimit}`);
  L.push('    /// TIMELINE_DIGEST — ask for the window as the collapsed timeline renders it.');
  L.push(`    static let timelineDigest = ${c.timelineDigest}`);
  L.push('');
  L.push(`    // MARK: - Stream reconnect (${SOURCES.stream})`);
  L.push('');
  L.push('    /// BACKOFFS, in seconds.');
  L.push(`    static let streamBackoffs: [TimeInterval] = [${c.streamBackoffsSec.map(sec).join(', ')}]`);
  L.push('    /// IDLE_DEAD_MS, in seconds — the server pings every 15s, so silence past');
  L.push('    /// this is a half-open connection, not a quiet session.');
  L.push(`    static let streamIdleDeadline: TimeInterval = ${sec(c.streamIdleDeadlineSec)}`);
  L.push('');
  L.push(`    // MARK: - Live Activity staleness (${SOURCES.liveActivity})`);
  L.push('');
  L.push('    /// WORKING_STALE_MS, in seconds. The server puts this same distance into');
  L.push('    /// every `staleDate` it pushes, so a smaller value here dims an activity');
  L.push('    /// the server still considers fresh.');
  L.push(`    static let workingStaleAfter: TimeInterval = ${sec(c.workingStaleSec)}`);
  L.push('    /// BLOCKED_STALE_MS, in seconds.');
  L.push(`    static let blockedStaleAfter: TimeInterval = ${sec(c.blockedStaleSec)}`);
  L.push('    /// LINGER_MS, in seconds.');
  L.push(`    static let lingerAfterEnd: TimeInterval = ${sec(c.lingerSec)}`);
  L.push('');
  L.push(`    // MARK: - Context bands (${SOURCES.ctxBar})`);
  L.push('');
  L.push(`    static let ctxDangerPct = ${c.ctxDangerPct}`);
  L.push(`    static let ctxWarnPct = ${c.ctxWarnPct}`);
  L.push('');
  L.push(`    // MARK: - Search over the cached prose (${SOURCES.search})`);
  L.push('    //');
  L.push('    // A hit rendered on the phone and the same hit rendered in the browser');
  L.push('    // have to be the same excerpt. These are the three numbers that decide');
  L.push('    // that: how much text surrounds the match, how many hits one page');
  L.push('    // carries, and where counting matches inside one message stops.');
  L.push('');
  L.push('    /// SNIPPET_PAD — characters of context kept on each side of the first');
  L.push('    /// match. Offsets are UTF-16 code units on both sides, because the web');
  L.push('    /// slices a JavaScript string with them.');
  L.push(`    static let snippetPad = ${c.snippetPad}`);
  L.push('    /// DEFAULT_PAGE — hits per page for the global search overlay. The');
  L.push('    /// in-session find asks for all of them instead.');
  L.push(`    static let searchPageSize = ${c.searchPageSize}`);
  L.push('    /// MAX_MATCHES_PER_ROW — matches counted within one message.');
  L.push(`    static let maxMatchesPerRow = ${c.maxMatchesPerRow}`);
  L.push('');
  L.push(`    // MARK: - Session status (${SOURCES.statusDots})`);
  L.push('    //');
  L.push('    // Read by the Swift port of `sessionStatusView` (Hermit/SessionStatus.swift).');
  L.push('    // Milliseconds, because that port keeps the original\'s clocks.');
  L.push('');
  L.push('    /// SNAPSHOT_STALE_MS — past this much gateway silence, `state` is a');
  L.push('    /// memory rather than an observation and the dot goes grey.');
  L.push(`    static let snapshotStaleMs: Double = ${c.snapshotStaleMs}`);
  L.push('    /// BACKGROUND_RESIDENT_MS — after this much quiet from the agent, an');
  L.push('    /// outstanding background task stops counting as part of the answer.');
  L.push(`    static let backgroundResidentMs: Double = ${c.backgroundResidentMs}`);
  L.push('');
  L.push('    // MARK: - Palette');
  L.push('    //');
  L.push('    // Exactly the Tailwind classes the two files above name, resolved through');
  L.push('    // Tailwind\'s own theme.css and converted from oklch to Display P3 — not to');
  L.push('    // sRGB, which clips three of them, and not to the v3 hexes, which are a');
  L.push('    // different palette (amber-400 has not been #FBBF24 since Tailwind 3).');
  L.push('');
  for (const p of c.palette) {
    L.push(`    /// \`${p.cls}\` — ${p.oklch}`);
    L.push(
      `    static let ${p.swiftName} = Color(.displayP3, red: ${chan(p.p3[0])}, green: ${chan(p.p3[1])}, blue: ${chan(p.p3[2])})`,
    );
  }
  L.push('}');
  L.push('');
  return L.join('\n');
}

export function renderCurrent(): string {
  return renderWebContractSwift(readContract());
}

export function checkedInSwift(): string {
  return readFileSync(join(REPO_ROOT, CONTRACT_SWIFT), 'utf8');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const out = join(REPO_ROOT, CONTRACT_SWIFT);
  const next = renderCurrent();
  let prev = '';
  try {
    prev = readFileSync(out, 'utf8');
  } catch {
    /* first run */
  }
  writeFileSync(out, next);
  console.log(prev === next ? `unchanged  ${CONTRACT_SWIFT}` : `wrote      ${CONTRACT_SWIFT}`);
}
