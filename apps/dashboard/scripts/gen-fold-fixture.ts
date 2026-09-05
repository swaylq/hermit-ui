/**
 * Renders `apps/ios/tools/fixtures/fold-cases.json` — the rows THIS `foldRuns`
 * produces today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:fold-fixture
 *
 * `src/components/chat/fold-runs.ts` decides what the timeline is: which rows
 * exist, in what order, and — the part that took a bug to get right — what each
 * one is called. `apps/ios/Hermit/FoldRuns.swift` is a second implementation of
 * it, and most of what decides these answers is invisible in the types:
 *
 *   · the unit is the BLOCK, so one message can yield a row, a capsule and
 *     another row, in that order;
 *   · a run is named after the row BELOW it, and the one with nothing below is
 *     the live one and keeps a sentinel;
 *   · `isMachineryBlock` looks at the wire `type` string alone, so a `tool_use`
 *     missing its `id` — which `parseBlock` demotes to `unknown` — still folds;
 *   · the `ask` tool call is the one tool_use that stays visible;
 *   · half of `stepFor` and `summarizeRun` is JavaScript coercion: `String(x)`,
 *     `??`, and a truthiness test on `is_error` and on `__d`.
 *
 * The INPUTS below are hand-written, transcribed from `fold-runs.test.ts` plus
 * the coercion cases that test does not need but a port does. The EXPECTATIONS
 * are not: they come out of running the real functions.
 *
 * Time zone is pinned to UTC on both sides — `isSameDay` asks the LOCAL
 * calendar, so the two implementations can only be compared under one.
 */
process.env.TZ = 'UTC';

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  foldRuns,
  summarizeRun,
  isMachineryBlock,
  closesRunUnconditionally,
  safeSplitIndex,
  OPEN_RUN_KEY,
  type FoldInput,
  type FoldedRow,
  type FoldedRun,
  type FoldedMsg,
  type RunStep,
} from '../src/components/chat/fold-runs';
import { isHarnessTerminator } from '../src/components/chat/lib';
import { parseBlock } from '../src/lib/chat-blocks';
import { capMessageContent } from '../src/server/message-cap';
import { digestMessageContent } from '../src/server/message-digest';

// Node resolves the zone once, on first use; if that happened before the line
// above then every day-boundary answer in here is this machine's, not UTC's.
if (new Date('2026-08-21T23:00:00.000Z').getDate() !== 21) {
  throw new Error('TZ=UTC did not take — run this script with TZ=UTC in the environment');
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = 'apps/ios/tools/fixtures/fold-cases.json';

const DAY = '2026-08-21T10:00:00.000Z';
const LATER = '2026-08-21T10:04:00.000Z';
const NEXT_DAY = '2026-08-22T10:00:00.000Z';

let seq = 0;
const row = (role: string, content: unknown, createdAt = DAY, authoredBy?: string | null) => ({
  id: `m${++seq}`,
  role,
  content,
  createdAt,
  ...(authoredBy === undefined ? {} : { authoredBy }),
});

const text = (t: string) => ({ type: 'text', text: t });
const call = (name: string, input: unknown = {}, id = `tu${++seq}`) => ({ type: 'tool_use', id, name, input });
const result = (content: unknown, is_error: unknown = false) => ({
  type: 'tool_result',
  tool_use_id: 'tu',
  content,
  is_error,
});
const think = (t: string) => ({ type: 'thinking', thinking: t });
const image = () => ({ type: 'image', source: { type: 'url', url: '/uploads/shot.png' } });
const askCall = (question: string) => ({
  type: 'tool_use',
  id: 'a1',
  name: 'mcp__hermit__ask',
  input: { question, options: [] },
});

// ── the shape both implementations project a fold into ──────────────────────
// Whole rows rather than a kind or a key, because half of what makes these two
// agree is which blocks landed in which row.

const projectStep = (st: RunStep) => {
  if (st.t === 'call') {
    return { t: 'call', id: st.call.id, name: st.call.name, input: st.call.input ?? null, d: !!st.call.d };
  }
  if (st.t === 'result') return { t: 'result', block: st.block ?? null, d: !!st.d };
  return { t: 'think', text: st.text, chars: st.chars };
};

const projectRow = (r: FoldedRow) => {
  if (r.kind === 'end') return { kind: 'end', key: r.key, ids: r.ids, createdAt: r.createdAt };
  if (r.kind === 'msg') {
    const m = r as FoldedMsg;
    return {
      kind: 'msg',
      key: m.key,
      ids: m.ids,
      role: m.role,
      authoredBy: m.authoredBy ?? null,
      blocks: m.blocks ?? [],
      // Ties the fold to the OTHER ported function: the phone renders these
      // through `ContentBlock.parse`, and a row whose blocks land on different
      // variants draws differently however right the fold was.
      blockKinds: (m.blocks ?? []).map((b) => parseBlock(b).type),
      createdAt: m.createdAt,
      msgId: m.msgId,
    };
  }
  const run = r as FoldedRun;
  const s = summarizeRun(run.steps);
  return {
    kind: 'run',
    key: run.key,
    ids: run.ids,
    from: run.from,
    to: run.to,
    steps: run.steps.map(projectStep),
    summary: {
      names: s.names,
      calls: s.calls,
      errors: s.errors,
      thinkChars: s.thinkChars,
      last: s.last ? { id: s.last.id, name: s.last.name, input: s.last.input ?? null, d: !!s.last.d } : null,
      digested: s.digested,
    },
  };
};

/** Exactly what a reader sees with nothing expanded. */
const collapsed = (rows: FoldedRow[]) =>
  rows.map((r) => {
    const p = projectRow(r) as Record<string, unknown>;
    delete p.steps;
    if (p.kind === 'run') {
      // `digested` and the last call's arguments are exactly what the digest
      // changes — the claim is about what a reader sees, and neither of these
      // is visible until they expand the capsule.
      const s = p.summary as Record<string, unknown>;
      p.summary = {
        names: s.names,
        calls: s.calls,
        errors: s.errors,
        thinkChars: s.thinkChars,
        last: (s.last as { name?: string } | null)?.name ?? null,
      };
    }
    if (p.kind === 'msg') {
      // Prose has to match to the character; a non-text block only has to still
      // be there and still be that kind, since the digest is allowed to strip
      // bytes out of one (that is the point of it).
      p.blocks = (p.blocks as Array<{ type?: string; text?: unknown }>).map((b) =>
        b?.type === 'text' ? { t: 'text', text: b.text ?? null } : { t: b?.type ?? null },
      );
    }
    return p;
  });

// ── isMachineryBlock ────────────────────────────────────────────────────────

const MACHINERY_CASES: Array<{ name: string; block: unknown }> = [
  { name: 'text', block: text('hi') },
  { name: 'tool_use', block: call('Read') },
  { name: 'tool_result', block: result('ok') },
  { name: 'thinking', block: think('hm') },
  { name: 'image', block: image() },
  { name: 'file', block: { type: 'file', source: { url: '/u/a.pdf' }, name: 'a.pdf' } },
  { name: 'interaction', block: { type: 'interaction', kind: 'question', payload: {}, status: 'pending' } },
  { name: 'ask/mcp', block: askCall('go?') },
  { name: 'ask/bare', block: { type: 'tool_use', id: 'a2', name: 'ask', input: { question: 'q' } } },
  { name: 'ask/slash', block: { type: 'tool_use', id: 'a3', name: 'hermit/ask', input: { question: 'q' } } },
  // Named `ask` but with nothing to ask: not the question card, so it is still
  // machinery and folds away.
  { name: 'ask/no-question', block: { type: 'tool_use', id: 'a4', name: 'ask', input: {} } },
  { name: 'ask/question-not-string', block: { type: 'tool_use', id: 'a5', name: 'ask', input: { question: 7 } } },
  { name: 'ask/input-string', block: { type: 'tool_use', id: 'a6', name: 'ask', input: 'q' } },
  { name: 'ask/no-input', block: { type: 'tool_use', id: 'a7', name: 'ask' } },
  // `parseBlock` demotes these to `unknown`; the fold does not care.
  { name: 'tool_use/no-id', block: { type: 'tool_use', name: 'Read', input: {} } },
  { name: 'tool_result/no-id', block: { type: 'tool_result', content: 'orphan' } },
  { name: 'unknown-type', block: { type: 'redacted_thinking', data: 'AAAA' } },
  { name: 'null', block: null },
  { name: 'number', block: 3 },
  { name: 'string', block: 'bare' },
  { name: 'array', block: [{ type: 'tool_use', id: 'x', name: 'Read' }] },
  { name: 'no-type', block: { id: 'x' } },
  { name: 'numeric-type', block: { type: 7 } },
];

// ── isHarnessTerminator ─────────────────────────────────────────────────────

const TERMINATOR_CASES: Array<{ name: string; content: unknown }> = [
  { name: 'plain', content: [text('No response requested.')] },
  { name: 'no-period', content: [text('No response requested')] },
  { name: 'mixed-case', content: [text('NO RESPONSE REQUESTED.')] },
  { name: 'padded', content: [text('  No response requested.  ')] },
  { name: 'with-thinking', content: [think('hm'), text('No response requested.')] },
  { name: 'with-empty-text', content: [text(''), text('No response requested.')] },
  { name: 'with-prose', content: [text('No response requested.'), text('but also this')] },
  { name: 'with-tool', content: [text('No response requested.'), call('Read')] },
  { name: 'only-thinking', content: [think('hm')] },
  { name: 'empty-array', content: [] },
  { name: 'string', content: 'No response requested.' },
  { name: 'null-element', content: [null] },
  { name: 'suffix', content: [text('No response requested. really')] },
];

// ── closesRunUnconditionally ────────────────────────────────────────────────

const SEAM_CASES: Array<{ name: string; message: unknown }> = [
  { name: 'prose', message: row('user', [text('hi')]) },
  { name: 'machinery-then-prose', message: row('assistant', [call('Bash'), text('done')]) },
  { name: 'prose-then-machinery', message: row('assistant', [text('before'), call('Grep')]) },
  { name: 'machinery-only', message: row('assistant', [call('Read')]) },
  { name: 'empty', message: row('user', []) },
  { name: 'terminator', message: row('assistant', [text('No response requested.')]) },
  { name: 'machinery-then-image', message: row('assistant', [call('Read'), image()]) },
  { name: 'string-content', message: row('user', 'hello') },
  { name: 'empty-string-content', message: row('user', '') },
  { name: 'null-content', message: row('user', null) },
  // A zero-length thinking block yields no STEP, but it is still machinery and
  // still resets the pending count — so this message does not close a run.
  { name: 'empty-thinking', message: row('assistant', [think('')]) },
];

// ── safeSplitIndex ──────────────────────────────────────────────────────────

seq = 900;
const SPLIT_MESSAGES = [row('user', [text('a')]), row('user', [text('b')]), row('user', [text('c')])];
seq = 950;
const ALL_MACHINERY = [row('assistant', [call('Read')]), row('user', [result('ok')])];

const SPLIT_CASES: Array<{ name: string; messages: unknown[]; at: number }> = [
  { name: 'prose/at-2', messages: SPLIT_MESSAGES, at: 2 },
  { name: 'prose/at-1', messages: SPLIT_MESSAGES, at: 1 },
  { name: 'prose/at-0', messages: SPLIT_MESSAGES, at: 0 },
  { name: 'prose/past-the-end', messages: SPLIT_MESSAGES, at: 99 },
  { name: 'all-machinery', messages: ALL_MACHINERY, at: 2 },
  { name: 'empty-list', messages: [], at: 3 },
];

// ── folds ───────────────────────────────────────────────────────────────────

const FOLDS: Array<{ name: string; messages: unknown[] }> = [];
const fold = (name: string, at: number, build: () => unknown[]) => {
  seq = at;
  FOLDS.push({ name, messages: build() });
};

fold('tool-chain-between-two-replies', 1, () => [
  row('user', [text('看下这个文件')]),
  row('assistant', [call('Read', { file_path: '/a.ts' })]),
  row('user', [result('file body')]),
  row('assistant', [call('Bash', { command: 'npm test' })]),
  row('user', [result('ok')]),
  row('assistant', [text('看完了，没问题')]),
]);
fold('prose-and-tools-in-one-message', 20, () => [
  row('assistant', [text('先读一下'), call('Read'), text('读完了')]),
]);
fold('tool-after-text', 30, () => [row('assistant', [call('Read'), text('结论')])]);
fold('thinking-is-machinery', 40, () => [
  row('assistant', [think('hmm'), call('Read')]),
  row('assistant', [text('done')]),
]);
fold('visible-blocks-are-never-folded', 50, () => [
  row('assistant', [call('Bash')]),
  row('assistant', [image()]),
  row('assistant', [call('Bash')]),
  row('system', [{ type: 'interaction', kind: 'question', payload: { question: 'q' }, status: 'pending' }]),
]);
fold('ask-stays-visible', 60, () => [row('assistant', [call('Read'), askCall('要继续吗')])]);
fold('run-never-spans-a-date-divider', 70, () => [
  row('assistant', [call('Read')], DAY),
  row('user', [result('x')], DAY),
  row('assistant', [call('Read')], NEXT_DAY),
  row('user', [result('x')], NEXT_DAY),
]);
fold('terminator-breaks-the-run', 80, () => [
  row('assistant', [call('Read')]),
  row('assistant', [text('No response requested.')]),
  row('assistant', [call('Read')]),
]);
fold('empty-message-keeps-a-row', 90, () => [row('assistant', [])]);
fold('all-machinery-message-has-no-row', 91, () => [row('assistant', [call('Read')])]);
fold('errors-are-counted', 100, () => [
  row('assistant', [call('Bash')]),
  row('user', [result('boom', true), result('ok')]),
]);
fold('digested-steps-are-flagged', 110, () => [
  row('assistant', [{ ...call('Read', { file_path: '/a.ts' }), __d: 1 }]),
  row('user', [{ ...result('first line'), __d: 1 }]),
]);
fold('digest-flag-is-truthiness-not-presence', 115, () => [
  row('assistant', [{ ...call('Read'), __d: 0 }, { ...call('Bash'), __d: '' }]),
]);
fold('digested-thinking-keeps-its-length', 120, () => [
  row('assistant', [{ type: 'thinking', thinking: '', chars: 4200 }]),
]);
fold('zero-length-thinking-yields-no-step', 121, () => [
  row('assistant', [think(''), call('Read')]),
  row('assistant', [text('after')]),
]);
fold('a-message-of-only-empty-thinking-has-no-row', 122, () => [row('assistant', [think('')])]);
fold('string-content-degrades-to-prose', 130, () => [
  { id: 'sc1', role: 'user', content: 'hello', createdAt: DAY },
]);
fold('user-rows-never-merge-into-a-run', 140, () => [
  row('assistant', [call('Read')]),
  row('user', [text('停')]),
  row('assistant', [call('Read')]),
]);
fold('authored-by-is-carried-through', 145, () => [
  row('user', [text('from the phone')], DAY, 'sway'),
  row('assistant', [text('ok')], DAY, null),
]);

// Key stability — the bug these exist for: "滚动会突变，向上滚了一下结果跳跃很多".
const startedMidRun = () => [
  row('assistant', [call('Bash', {}, 't10')]),
  row('user', [result('ok')]),
  row('assistant', [text('done')]),
];
fold('window-started-mid-run', 150, startedMidRun);
fold('window-started-mid-run/prepended', 150, () => {
  const loaded = startedMidRun();
  seq = 200;
  return [row('user', [text('go')]), row('assistant', [call('Read', {}, 't02')]), row('user', [result('ok')]), ...loaded];
});
fold('window-started-mid-run/appended', 150, () => {
  const loaded = startedMidRun();
  seq = 300;
  return [...loaded, row('assistant', [call('Bash', {}, 't13')])];
});
fold('open-run-keeps-the-sentinel', 500, () => [
  row('user', [text('go')]),
  row('assistant', [call('Bash', {}, 't1')]),
]);
fold('two-runs-in-one-message', 600, () => [
  row('assistant', [call('Bash', {}, 't1'), text('between'), call('Read', {}, 't2')]),
  row('assistant', [text('after')]),
]);
fold('every-key-is-unique', 700, () => [
  row('user', [text('go')]),
  row('assistant', [call('Bash', {}, 't1'), text('mid'), call('Read', {}, 't2')]),
  row('user', [result('ok'), result('ok')]),
  row('assistant', [text('done')]),
  row('assistant', [call('Bash', {}, 't3')]),
]);

// JavaScript coercion — what a port gets wrong when it reads the types instead
// of the code.
fold('coercions', 800, () => [
  row('assistant', [
    { type: 'tool_use', id: 42, name: 'Read', input: null },
    { type: 'tool_use', id: null, name: null },
    { type: 'tool_use', id: 'tu-x', name: 'Bash', input: [1, 'two', null] },
    { type: 'tool_use', id: true, name: 7.5 },
  ]),
  row('user', [
    result('x', 'true'),
    result('y', 0),
    result('z', 1),
    result('w', []),
    { type: 'tool_result', tool_use_id: 'tu', content: 'no error field' },
  ]),
  row('assistant', [
    { type: 'thinking', text: 'older shape' },
    // JS counts UTF-16 units, so an emoji is two and a CJK character is one.
    { type: 'thinking', thinking: '好👍' },
    { type: 'thinking', thinking: 'ignored', chars: 9 },
  ]),
  row('assistant', [text('end')]),
]);
fold('odd-content-columns', 850, () => [
  row('user', null),
  row('user', 12),
  row('user', { type: 'text', text: 'not an array' }),
  row('user', ''),
  row('user', [null, 3, 'bare', [{ type: 'text', text: 'nested' }]]),
]);
fold('same-utc-day-across-midnight-elsewhere', 870, () => [
  row('assistant', [call('Read')], '2026-08-21T00:30:00.000Z'),
  row('user', [result('ok')], '2026-08-21T23:30:00.000Z'),
  row('assistant', [text('done')], '2026-08-21T23:59:59.999Z'),
]);
fold('unparseable-timestamp-closes-the-run', 880, () => [
  row('assistant', [call('Read')], DAY),
  row('user', [result('ok')], 'not a date'),
  row('assistant', [text('done')], LATER),
]);

// ── the seam property ───────────────────────────────────────────────────────
// Folding in two halves at any safe seam must equal folding the whole. If it
// stops holding, a long session silently renders differently from a short one.

seq = 1000;
const SEAM_IDENTITY_MESSAGES = [
  row('user', [text('hello')]),
  row('assistant', [call('Read', { file_path: '/x' })]),
  row('user', [result('ok')]),
  row('assistant', [call('Bash', { command: 'ls' }), text('done')]),
  row('assistant', [text('before'), call('Grep', { pattern: 'x' })]),
  row('user', [result('ok')]),
  row('assistant', [text('finally')]),
  row('user', []),
  row('assistant', [call('Edit'), call('Write')]),
  row('assistant', [text('end')]),
  row('assistant', [think('hmm'), call('Read'), text('after thinking')]),
  row('assistant', [text('same day tail')], NEXT_DAY),
];
let seams = 0;
for (let at = 1; at < SEAM_IDENTITY_MESSAGES.length; at++) {
  if (safeSplitIndex(SEAM_IDENTITY_MESSAGES as FoldInput[], at) !== 0) seams++;
}

// ── the digest must be invisible until someone clicks ───────────────────────
// The property the live window's digest rests on: a COLLAPSED timeline folded
// from digested content is indistinguishable from one folded from full content.

const big = 'x'.repeat(30_000);
seq = 1100;
const DIGEST_MESSAGES = [
  row('user', [text('read the config and fix it')]),
  row('assistant', [think('a'.repeat(6_000)), call('Read', { file_path: '/a/b/config.ts' })]),
  row('user', [result(`export default {}\n${big}`)]),
  row('assistant', [call('Write', { file_path: '/a/b/config.ts', content: big })]),
  row('user', [result('boom: permission denied\n' + big, true)]),
  row('assistant', [text('权限不够，我换个路径'), call('Bash', { command: `echo ${big}` })]),
  row('user', [result([{ type: 'text', text: `first line\n${big}` }])]),
  row('user', [result([image()])]),
  row('assistant', [think(''), text('done')]),
  row('assistant', [askCall(`should I keep going?\n${'y'.repeat(400)}`)]),
  row('assistant', [text('tail')], NEXT_DAY),
];
const withContent = (rows: typeof DIGEST_MESSAGES, digest: boolean) =>
  rows.map((m) => ({
    ...m,
    content: digest ? digestMessageContent(capMessageContent(m.content)) : capMessageContent(m.content),
  }));

const FULL = withContent(DIGEST_MESSAGES, false);
const DIGESTED = withContent(DIGEST_MESSAGES, true);
const FULL_COLLAPSED = collapsed(foldRuns(FULL as FoldInput[]));
if (JSON.stringify(FULL_COLLAPSED) !== JSON.stringify(collapsed(foldRuns(DIGESTED as FoldInput[])))) {
  throw new Error('the digest changed the collapsed timeline — fix that before shipping a fixture that asserts it does not');
}

const fixture = {
  note: 'GENERATED by apps/dashboard/scripts/gen-fold-fixture.ts — do not hand-edit.',
  timezone: 'UTC',
  openRunKey: OPEN_RUN_KEY,
  machinery: MACHINERY_CASES.map((c) => ({
    name: c.name,
    block: c.block ?? null,
    expected: isMachineryBlock(c.block),
  })),
  terminators: TERMINATOR_CASES.map((c) => ({
    name: c.name,
    content: c.content ?? null,
    expected: isHarnessTerminator(c.content),
  })),
  seams: SEAM_CASES.map((c) => ({
    name: c.name,
    message: c.message,
    expected: closesRunUnconditionally(c.message as FoldInput),
  })),
  splits: SPLIT_CASES.map((c) => ({
    name: c.name,
    messages: c.messages,
    at: c.at,
    expected: safeSplitIndex(c.messages as FoldInput[], c.at),
  })),
  folds: FOLDS.map((f) => ({
    name: f.name,
    messages: f.messages,
    expected: foldRuns(f.messages as FoldInput[]).map(projectRow),
  })),
  seamIdentity: {
    messages: SEAM_IDENTITY_MESSAGES,
    seams,
    expected: foldRuns(SEAM_IDENTITY_MESSAGES as FoldInput[]).map(projectRow),
  },
  // Only the digested half ships: it is small by construction, and holding it
  // against the collapsed rows of the FULL content — folded by the web — is the
  // stronger statement anyway. The generator refuses to write a fixture where
  // the web itself does not have the property.
  digestInvariance: {
    messages: DIGESTED,
    expectedCollapsed: FULL_COLLAPSED,
  },
};

const dest = join(REPO_ROOT, OUT);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(fixture, null, 2) + '\n');
console.log(
  `${OUT}: ${fixture.folds.length} folds · ${fixture.machinery.length} machinery · ` +
    `${fixture.terminators.length} terminators · ${fixture.seams.length} seams · ` +
    `${fixture.splits.length} splits · ${seams} seam splits`,
);
