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
  pager: 'apps/dashboard/src/components/chat/use-older-pages.ts',
  stream: 'apps/dashboard/src/app/chat/page.tsx',
  liveActivity: 'apps/dashboard/src/server/push/live-activity.ts',
  statusDots: 'apps/dashboard/src/lib/session-status.ts',
  ctxBar: 'apps/dashboard/src/components/ctx-bar.tsx',
  search: 'apps/dashboard/src/lib/chat-cache/search-core.ts',
  theme: 'apps/dashboard/src/app/globals.css',
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

/**
 * A `--custom-property` from `globals.css`, in both schemes.
 *
 * The shadcn theme colours are not Tailwind palette entries — they are CSS
 * custom properties declared twice, once under `:root` and once under `.dark`,
 * and `text-muted-foreground` resolves to whichever block is in force. So a
 * phone drawing the same row needs BOTH values and has to pick at render time,
 * exactly like the browser does.
 *
 * Read as text rather than through a CSS parser for the same reason the two
 * `.tsx` sources are: a rename breaks it LOUDLY in `ios-contract.test.ts`,
 * which is the only place anyone finds out.
 */
export function readThemeVar(rel: string, name: string): { light: string; dark: string } {
  const src = read(rel);
  const block = (selector: string): string => {
    const re = new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`);
    const m = re.exec(src);
    if (!m) throw new Error(`${rel}: no \`${selector} { … }\` block`);
    return m[1];
  };
  const pick = (selector: string): string => {
    const body = block(selector);
    const hits = [...body.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))];
    if (hits.length !== 1) {
      throw new Error(`${rel} ${selector}: expected one \`--${name}\`, found ${hits.length}`);
    }
    return hits[0][1].trim();
  };
  return { light: pick(':root'), dark: pick('\\.dark') };
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

/**
 * `oklch(1 0 0 / 10%)` → `{ css: 'oklch(1 0 0)', alpha: 0.1 }`.
 *
 * Kept OUT of `parseOklch` on purpose: that function's three numbers go into
 * the colour-space conversion, and alpha goes nowhere near it — it is carried
 * to the Swift initialiser untouched. Splitting first also means every existing
 * caller and its assertions see the same shape they always did.
 */
export function splitAlpha(css: string): { css: string; alpha: number } {
  const m = /^(oklch\([^/)]*)\/\s*([\d.]+)(%?)\s*\)$/.exec(css.trim());
  if (!m) return { css: css.trim(), alpha: 1 };
  const raw = Number(m[2]);
  return { css: `${m[1].trimEnd()})`, alpha: m[3] === '%' ? raw / 100 : raw };
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

/**
 * One scheme's value of a theme variable.
 *
 * `oklch` is the declaration with any alpha stripped off, so anything reading
 * it back gets a colour it can parse; the alpha rides alongside as a number.
 * Only `--border` is translucent today (`oklch(1 0 0 / 10%)` in `.dark`), and
 * it is translucent for a reason a screenshot shows: a solid hairline at that
 * lightness reads as a rule across the dark timeline.
 */
export interface ThemeSide {
  /** `oklch(1 0 0)` — the declaration, alpha removed. */
  oklch: string;
  /** `oklch(1 0 0 / 10%)` — the declaration as globals.css writes it. */
  declared: string;
  p3: [number, number, number];
  /** 0…1. Exactly 1 for an opaque declaration. */
  alpha: number;
}

export interface ThemeEntry {
  /** `muted-foreground` — the CSS custom property, without the dashes. */
  cssVar: string;
  /** `mutedForeground` */
  swiftName: string;
  light: ThemeSide;
  dark: ThemeSide;
  /** What the row that reads it uses it for. */
  note: string;
}

export interface Contract {
  timelineLimit: number;
  timelineDigest: boolean;
  olderPage: number;
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
  theme: ThemeEntry[];
}

/**
 * The theme colours a native screen needs, and nothing else.
 *
 * Not every variable in `globals.css`: an unused colour over here is a value
 * nobody can check against anything, and the file has thirty. This list grows
 * one entry at a time, when a screen actually draws with it.
 */
export const THEME_VARS: ReadonlyArray<{ cssVar: string; note: string }> = [
  { cssVar: 'sidebar', note: 'the session list\'s own background' },
  { cssVar: 'sidebar-foreground', note: 'a session row\'s title' },
  { cssVar: 'sidebar-accent', note: 'the row you are looking at' },
  { cssVar: 'muted-foreground', note: 'the agent name, the time, the status word' },
  { cssVar: 'background', note: 'the page behind the timeline, and a user bubble\'s text' },
  { cssVar: 'foreground', note: 'body text, and the user bubble it is knocked out of' },
  { cssVar: 'muted', note: 'the fill behind a system row and an unknown block' },
  { cssVar: 'border', note: 'a run capsule\'s hairline' },
] as const;

/** `muted-foreground` → `mutedForeground` */
const camel = (v: string) => v.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Palette classes a native screen draws that `readColorClasses` cannot see.
 *
 * That scanner only matches a class ALONE inside quotes, which is how
 * `session-status.ts` and `ctx-bar.tsx` write theirs. The composer writes its
 * Stop pill's colours mid-string inside a `cn(...)` call, so they are named
 * here instead — with the file that draws them, so this stays a record of what
 * is on screen rather than a dumping ground. Same rule as THEME_VARS: one entry
 * at a time, when a screen actually uses it.
 */
export const EXTRA_CLASSES: ReadonlyArray<{ cls: string; note: string }> = [
  { cls: 'rose-600', note: "the composer's Stop pill in the light scheme (components/chat/composer.tsx)" },
  { cls: 'emerald-600', note: "a finished attachment's dimensions under its chip (components/chat/composer.tsx)" },
  { cls: 'neutral-800', note: 'the label on the lit send dome (components/chat/hold-to-talk.tsx)' },
  { cls: 'neutral-900', note: 'the transcript in the hold bubble, and a lit arc label (components/chat/hold-to-talk.tsx)' },
] as const;

const SHADE = (cls: string) => Number(cls.split('-')[1]);
const FAMILY = (cls: string) => cls.split('-')[0];

export function readContract(): Contract {
  const classes = [
    ...readColorClasses(SOURCES.statusDots, ['bg']),
    ...readColorClasses(SOURCES.ctxBar, ['bg', 'text']),
    ...EXTRA_CLASSES.map((e) => e.cls),
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

  const themeColors: ThemeEntry[] = THEME_VARS.map(({ cssVar, note }) => {
    const raw = readThemeVar(SOURCES.theme, cssVar);
    const conv = (css: string): ThemeSide => {
      const { css: bare, alpha } = splitAlpha(css);
      return { oklch: bare, declared: css.trim(), p3: oklchToDisplayP3(parseOklch(bare)), alpha };
    };
    return { cssVar, swiftName: camel(cssVar), light: conv(raw.light), dark: conv(raw.dark), note };
  });

  const bands = [...new Set([...read(SOURCES.ctxBar).matchAll(/pct\s*>=\s*(\d+)/g)].map((m) => Number(m[1])))]
    .sort((a, b) => b - a);
  if (bands.length !== 2) {
    throw new Error(`${SOURCES.ctxBar}: expected two \`pct >= N\` bands, found ${bands.length}`);
  }

  return {
    timelineLimit: INITIAL_WINDOW,
    timelineDigest: TIMELINE_DIGEST,
    olderPage: readNumberConst(SOURCES.pager, 'OLDER_PAGE'),
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
    theme: themeColors,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Swift literal for a duration. Every one of these divides 1000 evenly today;
 *  a fractional one still renders correctly as a Double literal. */
const sec = (n: number) => String(n);
const chan = (n: number) => n.toFixed(4);

/** One `Color(.displayP3, …)` literal, with `opacity:` only when it is not 1. */
const swiftColor = (s: ThemeSide) =>
  `Color(.displayP3, red: ${chan(s.p3[0])}, green: ${chan(s.p3[1])}, blue: ${chan(s.p3[2])}` +
  (s.alpha === 1 ? ')' : `, opacity: ${chan(s.alpha)})`);

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
  L.push(`    // MARK: - Load earlier (${SOURCES.pager})`);
  L.push('');
  L.push('    /// OLDER_PAGE — messages per "load earlier". Deliberately small: the web');
  L.push('    /// measured a bigger page blocking its main thread past the point where the');
  L.push('    /// prepend anchor gave up. The phone has no such deadline, but the two have');
  L.push('    /// to page in the same steps or the same scroll lands on different rows.');
  L.push(`    static let olderPage = ${c.olderPage}`);
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
  L.push('');
  L.push(`    // MARK: - Theme colours (${SOURCES.theme})`);
  L.push('    //');
  L.push('    // The shadcn variables, which are not palette entries: each is declared');
  L.push('    // twice in that file, under `:root` and under `.dark`, and the browser');
  L.push('    // picks by the scheme in force. So both values come across and the view');
  L.push('    // picks the same way — see `ThemeColor.resolve`.');
  L.push('    //');
  L.push('    // A declaration with an alpha (`--border` in `.dark`) keeps it: the');
  L.push('    // browser composites that hairline against whatever is behind it, and a');
  L.push('    // flattened one would be wrong on every background but the page\'s own.');
  L.push('');
  for (const t of c.theme) {
    L.push(`    /// \`--${t.cssVar}\` — ${t.note}.`);
    L.push(`    /// light ${t.light.declared} · dark ${t.dark.declared}`);
    L.push(`    static let ${t.swiftName} = ThemeColor(`);
    L.push(`        light: ${swiftColor(t.light)},`);
    L.push(`        dark: ${swiftColor(t.dark)}`);
    L.push('    )');
  }
  L.push('}');
  L.push('');
  L.push('/// One theme variable, in the two schemes it is declared in.');
  L.push('///');
  L.push('/// A `Color` that follows the scheme on its own would be a `UIColor` with a');
  L.push('/// trait-collection block, and that is UIKit — it would stop this file (and');
  L.push('/// every view reading it) from compiling for the Mac, which is how the');
  L.push('/// layouts get looked at without a simulator (tools/render-list.sh).');
  L.push('/// Carrying both and resolving against `\\.colorScheme` costs one call and');
  L.push('/// works everywhere SwiftUI does.');
  L.push('struct ThemeColor {');
  L.push('    let light: Color');
  L.push('    let dark: Color');
  L.push('    func resolve(_ scheme: ColorScheme) -> Color { scheme == .dark ? dark : light }');
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
