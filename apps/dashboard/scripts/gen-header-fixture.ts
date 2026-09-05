/**
 * Renders `apps/ios/tools/fixtures/header-cases.json` — the answers the WEB's
 * own chat-header vocabulary gives today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:header-fixture
 *
 * Seven small functions decide every string on the chat header's meta line, and
 * every one of them is small enough to look obviously right and not be:
 *
 *   · `fmtBytes` prints through `toFixed`, which rounds a tie AWAY from zero.
 *     C's `%.*f` — what Swift's `String(format:)` is — rounds a tie to even, so
 *     1250 tokens are `1.3k` in the browser and `1.2k` in a naive port.
 *   · `ctxPct`'s `!n` catches ZERO as well as absent.
 *   · `ctxFill` floors at 2, so "barely used" is a sliver and not an empty track.
 *   · `contextWindowFor` matches a model by PREFIX, longest first, and every
 *     backend it has not heard of takes the 1M default — including pi, on
 *     purpose.
 *   · `runtimeShortLabel` falls back to `Claude`, which is a real answer and not
 *     a shrug.
 *   · `providerMark` cuts a long provider with `slice(0, 11)`, and both `length`
 *     and `slice` count UTF-16 CODE UNITS. Swift's `count` counts graphemes, so
 *     a name with an emoji or a combining mark in it cuts somewhere else unless
 *     the port says `utf16` out loud. That is what the `provider` section is for.
 *   · `chatHeaderTitle` picks between four candidates by JS falsiness — an EMPTY
 *     title falls through to the preview, which is the state every brand-new
 *     session is in.
 *
 * So the table is produced by RUNNING those functions, and
 * `apps/ios/tools/header-fixture.sh` runs the Swift side over the same table. A
 * red line there is always two implementations disagreeing, never an
 * implementation disagreeing with a test author.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ctxFill, ctxPct, fmtBytes } from '../src/lib/format';
import {
  CODEX_DEFAULT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
  KIMI_DEFAULT_WINDOW,
  contextWindowFor,
} from '../src/lib/context-window';
import { providerMark, runtimeShortLabel } from '../src/lib/runtime-labels';
import { chatHeaderTitle } from '../src/lib/chat-header';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_JSON = 'apps/ios/tools/fixtures/header-cases.json';

// ---------------------------------------------------------------------------
// fmtBytes — the tier boundaries, and every tie toFixed can round
// ---------------------------------------------------------------------------

const BYTES: (number | null)[] = [
  null, 0, 1, 999,
  // the k tier opens here, and 1250 is the tie that separates JS from C
  1000, 1050, 1150, 1250, 1350, 1449, 1450, 9999, 12_345, 999_949, 999_950,
  // M
  1_000_000, 1_005_000, 1_015_000, 1_234_567, 12_345_678, 999_994_999,
  // B
  1_000_000_000, 1_005_000_000, 1_250_000_000, 10_641_710_000,
];

// ---------------------------------------------------------------------------
// ctxPct / ctxFill — including the two the bar's colour bands turn on
// ---------------------------------------------------------------------------

const PCT: { tokens: number | null; total: number }[] = [
  { tokens: null, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 0, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 1, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 19_999, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 20_000, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 699_999, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 700_000, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 899_999, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 900_000, total: DEFAULT_CONTEXT_WINDOW },
  { tokens: 1_000_000, total: DEFAULT_CONTEXT_WINDOW },
  // over the window: the web clamps, it does not draw past the end
  { tokens: 1_400_000, total: DEFAULT_CONTEXT_WINDOW },
  // the same occupancy against a codex window, which is the bug lib/context-window
  // was written to fix: 155k of 258.4k is 60%, not 15.5%
  { tokens: 155_000, total: CODEX_DEFAULT_WINDOW },
  { tokens: 155_000, total: KIMI_DEFAULT_WINDOW },
];

// ---------------------------------------------------------------------------
// contextWindowFor — the prefix tables, their order, and the defaults
// ---------------------------------------------------------------------------

const WINDOWS: { runtime: string | null; model: string | null }[] = [
  { runtime: null, model: null },
  { runtime: 'claude-sdk', model: 'opus' },
  { runtime: 'claude-tmux', model: null },
  { runtime: 'pi-rpc', model: 'anything' },
  { runtime: 'dsh-exec', model: 'deepseek-v4' },
  // codex: exact, dated suffix, the spark entry that must not be shadowed,
  // an unknown model, no model at all, and one that is only cased differently
  { runtime: 'codex-exec', model: 'gpt-5.6' },
  { runtime: 'codex-exec', model: 'gpt-5.6-sol-wm' },
  { runtime: 'codex-exec', model: 'gpt-5.3-codex-spark' },
  { runtime: 'codex-exec', model: 'GPT-5.6' },
  { runtime: 'codex-exec', model: '  gpt-5.5  ' },
  { runtime: 'codex-exec', model: 'gpt-4o' },
  { runtime: 'codex-exec', model: '' },
  { runtime: 'codex-exec', model: null },
  // kimi: k3-256k must win over k3
  { runtime: 'kimi-code', model: 'k3' },
  { runtime: 'kimi-code', model: 'k3-256k' },
  { runtime: 'kimi-code', model: 'k3[1m]' },
  { runtime: 'kimi-code', model: 'kimi-for-coding' },
  { runtime: 'kimi-code', model: 'k2' },
  { runtime: 'kimi-code', model: null },
  // a harness this build has never heard of
  { runtime: 'teleport-rpc', model: 'x' },
];

// ---------------------------------------------------------------------------
// runtimeShortLabel
// ---------------------------------------------------------------------------

const RUNTIMES: (string | null)[] = [
  null, '', 'claude-sdk', 'claude-tmux', 'pi-rpc', 'prime-rpc', 'codex-exec',
  'dsh-exec', 'kimi-code', 'omp-rpc', 'teleport-rpc',
];

// ---------------------------------------------------------------------------
// providerMark — the spelling table, and the UTF-16 cut
// ---------------------------------------------------------------------------

const PROVIDERS: (string | null)[] = [
  null, '', '   ',
  'kimi-coding', 'moonshotai-cn', 'MoonshotAI', 'zai', 'openrouter', 'deepseek',
  // trimmed before the table is consulted
  '  kimi  ',
  // free text, under and over the 12-code-unit cut
  'anthropic', 'twelve chars', 'thirteen chars',
  // exactly 12, then exactly 13
  'aaaaaaaaaaaa', 'aaaaaaaaaaaaa',
  // a name that is 13 GRAPHEMES but 14 code units — a port counting characters
  // keeps a letter this one drops
  'ab\u{1F600}cdefghijkl',
  // combining mark sitting on the 11th code unit: JS cuts between the base
  // letter and its accent, a grapheme-wise port keeps them together
  'abcdefghije\u{0301}fgh',
  // CJK, which is one code unit per character and must NOT be treated as wide
  '\u{6708}\u{4E4B}\u{6697}\u{9762}\u{7684}\u{4F9B}\u{5E94}\u{5546}\u{4E00}\u{4E8C}\u{4E09}\u{56DB}\u{4E94}',
];

// ---------------------------------------------------------------------------
// chatHeaderTitle
// ---------------------------------------------------------------------------

type TitleCase = {
  why: string;
  session: { title?: string | null; preview?: string | null; agentName?: string | null } | null;
  sessionId: string;
};

const TITLES: TitleCase[] = [
  { why: 'the ordinary case', session: { title: 'Ship the header', preview: 'p', agentName: 'asst' }, sessionId: 'abcdefgh-1234' },
  { why: 'a brand-new session: the title column is an EMPTY STRING, not null', session: { title: '', preview: 'do the thing', agentName: 'asst' }, sessionId: 'abcdefgh-1234' },
  { why: 'null title', session: { title: null, preview: 'do the thing', agentName: 'asst' }, sessionId: 'abcdefgh-1234' },
  { why: 'no title and no preview', session: { title: null, preview: null, agentName: 'asst' }, sessionId: 'abcdefgh-1234' },
  { why: 'empty preview falls through too', session: { title: '', preview: '', agentName: 'asst' }, sessionId: 'abcdefgh-1234' },
  { why: 'nothing at all: the id, first eight', session: { title: null, preview: null, agentName: null }, sessionId: 'abcdefgh-1234' },
  { why: 'no session yet — the header paints before getSession answers', session: null, sessionId: 'abcdefgh-1234' },
  { why: 'a short id is not padded', session: null, sessionId: 'abc' },
  { why: 'slice(0, 8) counts UTF-16 code units, so this id is cut mid-pair on the web too', session: null, sessionId: 'ab\u{1F600}cdefghij' },
  { why: 'whitespace is NOT trimmed here — a title of one space is a title', session: { title: ' ', preview: 'p', agentName: 'asst' }, sessionId: 'abcdefgh-1234' },
];

function buildFixture() {
  return {
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    codexDefaultWindow: CODEX_DEFAULT_WINDOW,
    kimiDefaultWindow: KIMI_DEFAULT_WINDOW,
    bytes: BYTES.map((n) => ({ n, expected: fmtBytes(n) })),
    pct: PCT.map((c) => {
      const pct = ctxPct(c.tokens, c.total);
      return { ...c, pct, fill: ctxFill(pct) };
    }),
    windows: WINDOWS.map((c) => ({ ...c, window: contextWindowFor(c.runtime, c.model) })),
    runtimes: RUNTIMES.map((kind) => ({ kind, label: runtimeShortLabel(kind) })),
    providers: PROVIDERS.map((provider) => ({ provider, mark: providerMark(provider) })),
    titles: TITLES.map((c) => ({ ...c, expected: chatHeaderTitle(c.session, c.sessionId) })),
  };
}

const out = join(REPO_ROOT, FIXTURE_JSON);
mkdirSync(dirname(out), { recursive: true });
const f = buildFixture();
writeFileSync(out, JSON.stringify(f, null, 2) + '\n');
console.log(
  `wrote      ${FIXTURE_JSON}  (${f.bytes.length} bytes, ${f.pct.length} pct, ${f.windows.length} windows, ` +
    `${f.runtimes.length} runtimes, ${f.providers.length} providers, ${f.titles.length} titles)`,
);
