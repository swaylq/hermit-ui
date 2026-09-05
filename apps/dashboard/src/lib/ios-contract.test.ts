// The numbers the iOS app is not allowed to disagree with.
//
// `apps/ios` is a second implementation of this product, and a handful of
// values have to be the SAME value there: the live window it asks for, the
// reconnect schedule, how long a Live Activity may sit before iOS dims it, the
// status colours. Each of those was hand-copied into Swift, and hand-copies
// drift silently — the Lock Screen's working-state staleness was 10 minutes
// against this server's 15 for weeks, which dimmed the activity in the middle
// of a long tool call and then quietly un-dimmed it on the next push. Nothing
// was red anywhere; there was no test that could have been.
//
// So `apps/ios/Shared/WebContract.swift` is GENERATED from this app
// (scripts/gen-ios-contract.ts) and this file is what makes that stick: it
// fails while the checked-in Swift is stale, which is the only reason a
// developer with no Mac in the loop finds out. Regenerate with
//
//     pnpm --filter @hermit-ui/dashboard gen:ios-contract
//
// Everything here reads files off disk and touches no database, so it runs in
// the same `pnpm test` pass as everything else.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONTRACT_SWIFT,
  REPO_ROOT,
  SOURCES,
  checkedInSwift,
  oklchToDisplayP3,
  parseOklch,
  readContract,
  readThemeVar,
  renderCurrent,
} from '../../scripts/gen-ios-contract';

const swift = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const STATUS_PALETTE = 'apps/ios/Shared/StatusPalette.swift';
const LIVE_ACTIVITY = 'apps/ios/Hermit/LiveActivityManager.swift';
const STREAM = 'apps/ios/Hermit/HermitStream.swift';
const ROW = 'apps/ios/Hermit/SessionRowView.swift';
const LIST = 'apps/ios/Hermit/SessionListViewController.swift';

test('the checked-in WebContract.swift is what this app renders today', () => {
  assert.equal(
    checkedInSwift(),
    renderCurrent(),
    `${CONTRACT_SWIFT} is stale. Run: pnpm --filter @hermit-ui/dashboard gen:ios-contract`,
  );
});

// Reference values from a SECOND conversion of the same oklch declarations.
// Pinning the generator against an independent one is the only way to know a
// refactor of the matrices below still lands on the colour Safari draws — the
// generated file would otherwise be self-consistent and wrong.
//
// The first seven are what the palette carried while it was still hand-written,
// from whatever tool converted them originally. `rose-600` (the composer's Stop
// pill) was added later and converted through the CSS Color 4 spec's own
// OKLab→LMS→XYZ→P3 matrices, which is a different code path from the one in
// gen-ios-contract — the same script reproduced all seven above it to within
// this tolerance before its answer for rose-600 was written down here.
const HAND_CONVERTED: Record<string, [number, number, number]> = {
  'amber-400': [0.9593, 0.7385, 0.1175],
  'rose-500': [0.9219, 0.2406, 0.3555],
  'zinc-400': [0.6227, 0.6226, 0.6596],
  'sky-400': [0.3061, 0.725, 0.9799],
  'emerald-500': [0.2673, 0.7268, 0.5082],
  'emerald-400': [0.3349, 0.8196, 0.5913],
  'rose-400': [0.943, 0.4307, 0.5029],
  'rose-600': [0.8488, 0.102, 0.2693],
  'emerald-600': [0.2066, 0.5891, 0.414],
};

test('oklch → Display P3 lands where the hand conversion landed', () => {
  const palette = readContract().palette;
  assert.equal(palette.length, Object.keys(HAND_CONVERTED).length);
  for (const p of palette) {
    const want = HAND_CONVERTED[p.cls];
    assert.ok(want, `${p.cls} is new to the palette; add its reference value here`);
    for (let i = 0; i < 3; i++) {
      // 0.001 is a quarter of an 8-bit step: below anything an eye or a
      // screenshot diff resolves, tight enough to catch a wrong matrix.
      assert.ok(
        Math.abs(p.p3[i] - want[i]) < 0.001,
        `${p.cls} channel ${i}: ${p.p3[i].toFixed(4)} vs ${want[i]}`,
      );
    }
  }
});

test('oklch parsing accepts both spellings of lightness', () => {
  assert.deepEqual(parseOklch('oklch(82.8% 0.189 84.429)'), { l: 0.828, c: 0.189, h: 84.429 });
  assert.deepEqual(parseOklch('oklch(0.828 0.189 84.429)'), { l: 0.828, c: 0.189, h: 84.429 });
  assert.throws(() => parseOklch('#fbbf24'), /not an oklch/);
  // Pure white and pure black survive the round trip without clipping noise.
  const white = oklchToDisplayP3({ l: 1, c: 0, h: 0 });
  white.forEach((v) => assert.ok(Math.abs(v - 1) < 0.001, `white channel ${v}`));
  const black = oklchToDisplayP3({ l: 0, c: 0, h: 0 });
  black.forEach((v) => assert.equal(v, 0));
});

test('every WebContract member the Swift app reads still exists', () => {
  const contract = checkedInSwift();
  const declared = new Set(
    [...contract.matchAll(/^\s{4}static let (\w+)/gm)].map((m) => m[1]),
  );
  assert.ok(declared.size >= 12, `only ${declared.size} members generated`);

  const readers = [STATUS_PALETTE, LIVE_ACTIVITY, STREAM, ROW, LIST];
  const used = new Set<string>();
  for (const rel of readers) {
    for (const m of swift(rel).matchAll(/\bWebContract\.(\w+)/g)) used.add(m[1]);
  }
  assert.ok(used.size > 0, 'no Swift file reads WebContract — is the generator wired up?');
  for (const name of used) {
    assert.ok(
      declared.has(name),
      `Swift reads WebContract.${name}, which the web no longer produces. ` +
        `A class or constant was renamed or dropped on this side.`,
    );
  }
});

test('the hand-written Swift no longer carries copies of these numbers', () => {
  // A colour literal back in StatusPalette means someone edited the palette on
  // the phone, which is the drift this whole mechanism exists to stop.
  assert.equal(
    swift(STATUS_PALETTE).includes('Color(.displayP3'),
    false,
    `${STATUS_PALETTE} declares a raw colour again; it should read WebContract`,
  );
  for (const name of ['workingStaleAfter', 'blockedStaleAfter', 'lingerAfterEnd']) {
    const re = new RegExp(`static let ${name}: TimeInterval = (.+)`);
    const m = re.exec(swift(LIVE_ACTIVITY));
    assert.ok(m, `${LIVE_ACTIVITY} no longer declares ${name}`);
    assert.match(m[1], /^WebContract\./, `${name} is a literal again: ${m[1]}`);
  }
  for (const decl of [
    /static let limit = (.+)/,
    /static let digest = (.+)/,
    /backoffs: \[TimeInterval\] = (.+),/,
    /idleDeadline: TimeInterval = (.+),/,
  ]) {
    const m = decl.exec(swift(STREAM));
    assert.ok(m, `${STREAM} no longer matches ${decl}`);
    assert.match(m[1], /^WebContract\./, `stream default is a literal again: ${m[1]}`);
  }
});

// `amber400` → `amber-400`. The generated names are the web's names with the
// hyphen dropped, which is what lets this go back the other way.
function swiftNameToClass(name: string): string {
  const m = /^([a-z]+)(\d{2,3})$/.exec(name);
  assert.ok(m, `not a palette name: ${name}`);
  return `${m[1]}-${m[2]}`;
}

/** `static let rose = WebContract.rose500` → rose ↦ rose-500 */
function paletteAliases(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of swift(STATUS_PALETTE).matchAll(/static let (\w+) = WebContract\.(\w+)$/gm)) {
    out.set(m[1], swiftNameToClass(m[2]));
  }
  return out;
}

/** The classes a `pct >= …` ladder returns, worst band first. */
function bandClasses(src: string, fn: RegExp, pick: (line: string) => string | null): string[] {
  const body = fn.exec(src);
  assert.ok(body, `could not find the band function: ${fn}`);
  return body[1]
    .split('\n')
    .map(pick)
    .filter((c): c is string => c !== null);
}

test('the context bands map to the same colours on both sides', () => {
  const aliases = paletteAliases();
  const ts = swift(SOURCES.ctxBar);
  const sw = swift(STATUS_PALETTE);

  const tsClass = (line: string) => {
    const m = /return '(?:bg|text)-([a-z]+-\d{2,3})'/.exec(line);
    return m ? m[1] : null;
  };
  // Both ladders are `if <threshold> return <colour>` lines, guard first; the
  // Swift one wraps the return in braces and may trail a comment.
  const swClass = (line: string) => {
    const m = /return\s+(\w+)/.exec(line);
    return m ? (aliases.get(m[1]) ?? `UNKNOWN(${m[1]})`) : null;
  };

  assert.deepEqual(
    bandClasses(sw, /static func ctxBar\(_ pct: Int\) -> Color \{([\s\S]*?)\n    \}/, swClass),
    bandClasses(ts, /function barColor\(pct: number\): string \{([\s\S]*?)\n\}/, tsClass),
    'the bar colour disagrees with components/ctx-bar.tsx',
  );
  assert.deepEqual(
    bandClasses(sw, /static func ctxText\(_ pct: Int\) -> Color \{([\s\S]*?)\n    \}/, swClass),
    bandClasses(ts, /function textColor\(pct: number\): string \{([\s\S]*?)\n\}/, tsClass),
    'the percentage colour disagrees with components/ctx-bar.tsx',
  );
});

test('the status dot classes are all colours the phone has', () => {
  const known = new Set(readContract().palette.map((p) => p.cls));
  const used = [...swift(SOURCES.statusDots).matchAll(/dot: [^,\n]*?'bg-([a-z]+-\d{2,3})/g)].map(
    (m) => m[1],
  );
  assert.ok(used.length >= 5, `only found ${used.length} dot colours in ${SOURCES.statusDots}`);
  for (const cls of new Set(used)) {
    assert.ok(known.has(cls), `session-status.ts uses bg-${cls}, which is not in the iOS palette`);
  }
});

// ---------------------------------------------------------------------------
// The theme colours — `--sidebar`, `--muted-foreground` and friends.
//
// Not Tailwind palette entries: each is a CSS custom property declared twice in
// globals.css, under `:root` and under `.dark`, and the browser picks by the
// scheme in force. A native row has to carry both and pick the same way, which
// is what `ThemeColor` is for.
// ---------------------------------------------------------------------------

test('the theme variables come across in both schemes', () => {
  const theme = readContract().theme;
  assert.ok(theme.length >= 4, `only ${theme.length} theme colours generated`);
  for (const t of theme) {
    assert.notDeepEqual(
      t.light.p3,
      t.dark.p3,
      `--${t.cssVar} is the same colour in both schemes; is one block missing it?`,
    );
    // Every one of these is a neutral (chroma 0) today. If that ever stops
    // being true this assertion is the place to find out, because a coloured
    // theme variable would need a second look at the conversion below.
    assert.equal(parseOklch(t.light.oklch).c, 0, `--${t.cssVar} light is no longer neutral`);
    assert.equal(parseOklch(t.dark.oklch).c, 0, `--${t.cssVar} dark is no longer neutral`);
  }
});

test('a neutral oklch converts to a neutral, at the value the transfer function gives', () => {
  // Independent of the matrices: at chroma 0 the Oklab → linear-sRGB step
  // collapses to L³ on all three channels, and a neutral is the same neutral in
  // Display P3 as in sRGB (the two share a white point and a transfer function).
  // So the whole conversion has to reduce to gamma(L³) — computed here from the
  // sRGB spec rather than from anything the generator uses.
  const srgbTransfer = (u: number) =>
    u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  for (const l of [0.145, 0.205, 0.269, 0.556, 0.708, 0.97, 0.985]) {
    const [r, g, b] = oklchToDisplayP3({ l, c: 0, h: 0 });
    const want = srgbTransfer(l ** 3);
    for (const [i, ch] of [r, g, b].entries()) {
      assert.ok(
        Math.abs(ch - want) < 0.0005,
        `oklch(${l} 0 0) channel ${i}: ${ch.toFixed(4)} vs ${want.toFixed(4)}`,
      );
    }
  }
});

test('reading a theme variable fails loudly when it is renamed away', () => {
  const got = readThemeVar(SOURCES.theme, 'sidebar-foreground');
  assert.match(got.light, /^oklch\(/);
  assert.match(got.dark, /^oklch\(/);
  assert.notEqual(got.light, got.dark);
  assert.throws(
    () => readThemeVar(SOURCES.theme, 'sidebar-foregruond'),
    /expected one/,
    'a typo in a variable name has to throw, not return a default',
  );
});

test('the native session row still reads its colours from the contract', () => {
  // The whole point of generating these. A literal back in the row means
  // someone typed a colour on the phone, and a background half a percent off
  // the web's would look right in every screenshot ever taken of it.
  for (const rel of [ROW, LIST]) {
    assert.equal(
      swift(rel).includes('Color(.displayP3'),
      false,
      `${rel} declares a raw colour; it should read WebContract`,
    );
  }
  const themeNames = new Set(readContract().theme.map((t) => t.swiftName));
  const resolved = [...swift(ROW).matchAll(/\bWebContract\.(\w+)\.resolve\b/g)].map((m) => m[1]);
  assert.ok(resolved.length > 0, `${ROW} resolves no theme colour at all`);
  for (const name of resolved) {
    assert.ok(themeNames.has(name), `${ROW} resolves WebContract.${name}, which is not a ThemeColor`);
  }
});
