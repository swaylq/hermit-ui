import assert from 'node:assert/strict';
import test from 'node:test';
import {
  foldRuns,
  summarizeRun,
  isMachineryBlock,
  OPEN_RUN_KEY,
  type FoldedRow,
  type FoldedRun,
  type FoldedMsg,
  safeSplitIndex,
  closesRunUnconditionally,
} from './fold-runs';

const msg = (r: FoldedRow): FoldedMsg => {
  assert.equal(r.kind, 'msg');
  return r as FoldedMsg;
};
const texts = (r: FoldedRow): unknown[] => msg(r).blocks.map((b) => b.text);

const DAY = '2026-08-21T10:00:00.000Z';
const NEXT_DAY = '2026-08-22T10:00:00.000Z';

let seq = 0;
const row = (role: string, content: unknown[], createdAt = DAY) => ({
  id: `m${++seq}`,
  role,
  content,
  createdAt,
});

const text = (t: string) => ({ type: 'text', text: t });
const call = (name: string, input: unknown = {}, id = `tu${++seq}`) => ({ type: 'tool_use', id, name, input });
const result = (content: unknown, is_error = false) => ({ type: 'tool_result', tool_use_id: 'tu', content, is_error });
const think = (t: string) => ({ type: 'thinking', thinking: t });
const image = () => ({ type: 'image', source: { type: 'url', url: '/uploads/shot.png' } });
const askCall = (question: string) => ({ type: 'tool_use', id: 'a1', name: 'mcp__hermit__ask', input: { question, options: [] } });

const kinds = (rows: FoldedRow[]) => rows.map((r) => r.kind);

test('a tool chain between two replies folds into one run', () => {
  const rows = foldRuns([
    row('user', [text('看下这个文件')]),
    row('assistant', [call('Read', { file_path: '/a.ts' })]),
    row('user', [result('file body')]),
    row('assistant', [call('Bash', { command: 'npm test' })]),
    row('user', [result('ok')]),
    row('assistant', [text('看完了，没问题')]),
  ]);
  assert.deepEqual(kinds(rows), ['msg', 'run', 'msg']);
  const run = rows[1] as FoldedRun;
  assert.equal(run.steps.length, 4);
  assert.deepEqual(run.ids.length, 4);
  const s = summarizeRun(run.steps);
  assert.deepEqual(s.names, ['Read', 'Bash']);
  assert.equal(s.calls, 2);
  assert.equal(s.errors, 0);
  assert.equal(s.last?.name, 'Bash');
});

test('prose and tools in ONE message split around the capsule, in order', () => {
  const rows = foldRuns([row('assistant', [text('先读一下'), call('Read'), text('读完了')])]);
  assert.deepEqual(kinds(rows), ['msg', 'run', 'msg']);
  assert.deepEqual(texts(rows[0]), ['先读一下']);
  assert.deepEqual(texts(rows[2]), ['读完了']);
  // Two rows out of one message need distinct window keys but the SAME msg id.
  assert.notEqual(rows[0].key, rows[2].key);
  assert.deepEqual(rows[0].ids, rows[2].ids);
});

test('tool_use AFTER text keeps its order (the capsule follows the bubble)', () => {
  const rows = foldRuns([row('assistant', [call('Read'), text('结论')])]);
  assert.deepEqual(kinds(rows), ['run', 'msg']);
});

test('thinking is machinery and lands in the run', () => {
  const rows = foldRuns([row('assistant', [think('hmm'), call('Read')]), row('assistant', [text('done')])]);
  assert.deepEqual(kinds(rows), ['run', 'msg']);
  const s = summarizeRun((rows[0] as FoldedRun).steps);
  assert.equal(s.thinkChars, 3);
  assert.equal(s.calls, 1);
});

test('images, files and interaction cards are never folded', () => {
  const rows = foldRuns([
    row('assistant', [call('Bash')]),
    row('assistant', [image()]),
    row('assistant', [call('Bash')]),
    row('system', [{ type: 'interaction', kind: 'question', payload: { question: 'q' }, status: 'pending' }]),
  ]);
  assert.deepEqual(kinds(rows), ['run', 'msg', 'run', 'msg']);
});

test('the ask tool_use stays visible — it is the question card', () => {
  assert.equal(isMachineryBlock(askCall('要继续吗')), false);
  const rows = foldRuns([row('assistant', [call('Read'), askCall('要继续吗')])]);
  assert.deepEqual(kinds(rows), ['run', 'msg']);
  assert.equal(msg(rows[1]).blocks[0].name, 'mcp__hermit__ask');
});

test('a run never spans a date divider', () => {
  const rows = foldRuns([
    row('assistant', [call('Read')], DAY),
    row('user', [result('x')], DAY),
    row('assistant', [call('Read')], NEXT_DAY),
    row('user', [result('x')], NEXT_DAY),
  ]);
  assert.deepEqual(kinds(rows), ['run', 'run']);
  assert.equal((rows[0] as FoldedRun).steps.length, 2);
  assert.equal((rows[1] as FoldedRun).steps.length, 2);
});

test('the harness terminator breaks the run and keeps its own row', () => {
  const rows = foldRuns([
    row('assistant', [call('Read')]),
    row('assistant', [text('No response requested.')]),
    row('assistant', [call('Read')]),
  ]);
  assert.deepEqual(kinds(rows), ['run', 'end', 'run']);
});

test('an empty message still produces a row; an all-machinery one does not', () => {
  assert.deepEqual(kinds(foldRuns([row('assistant', [])])), ['msg']);
  assert.deepEqual(kinds(foldRuns([row('assistant', [call('Read')])])), ['run']);
});

test('errors are counted for the capsule badge', () => {
  const rows = foldRuns([
    row('assistant', [call('Bash')]),
    row('user', [result('boom', true), result('ok')]),
  ]);
  const s = summarizeRun((rows[0] as FoldedRun).steps);
  assert.equal(s.errors, 1);
});

test('digested steps are flagged so the capsule knows to fetch on expand', () => {
  const rows = foldRuns([
    row('assistant', [{ ...call('Read', { file_path: '/a.ts' }), __d: 1 }]),
    row('user', [{ ...result('first line'), __d: 1 }]),
  ]);
  assert.equal(summarizeRun((rows[0] as FoldedRun).steps).digested, true);
  const clean = foldRuns([row('assistant', [call('Read')])]);
  assert.equal(summarizeRun((clean[0] as FoldedRun).steps).digested, false);
});

test('a digested thinking block keeps its length without its body', () => {
  const rows = foldRuns([row('assistant', [{ type: 'thinking', thinking: '', chars: 4200 }])]);
  const s = summarizeRun((rows[0] as FoldedRun).steps);
  assert.equal(s.thinkChars, 4200);
  assert.equal(s.digested, true);
});

test('a string content column degrades to one prose row', () => {
  const rows = foldRuns([{ id: 'x', role: 'user', content: 'hello', createdAt: DAY }]);
  assert.deepEqual(kinds(rows), ['msg']);
  assert.deepEqual(msg(rows[0]).blocks, [{ type: 'text', text: 'hello' }]);
});

test('user rows never merge into a run even when adjacent to one', () => {
  const rows = foldRuns([
    row('assistant', [call('Read')]),
    row('user', [text('停')]),
    row('assistant', [call('Read')]),
  ]);
  assert.deepEqual(kinds(rows), ['run', 'msg', 'run']);
  assert.equal(msg(rows[1]).role, 'user');
});

// ── Key stability ───────────────────────────────────────────────────────────
// The bug these exist for: sway, 2026-08-21, "滚动会突变，向上滚了一下结果跳跃很多".
// A run keyed by the message that OPENED it is stable only while history grows
// downward. "Load earlier" grows it upward — the loaded window began in the
// middle of a turn's machinery — so the topmost run re-opened at an older
// message and changed key. That row is the one under the reader's eyes at the
// moment they trigger the load, and losing its key loses its measured height,
// the windowing hook's start anchor and the DOM element itself.

const keys = (rows: FoldedRow[]) => rows.map((r) => `${r.kind}:${r.key}`);

// The window starts mid-machinery, then some prose. Exactly what a page
// boundary landing inside a turn produces.
const startedMidRun = () => {
  seq = 100;
  return [
    row('assistant', [call('Bash', {}, 't10')]),
    row('user', [result('ok')]),
    row('assistant', [text('done')]),
  ];
};

test('a run keeps its key when history is prepended above it', () => {
  const loaded = startedMidRun();
  const before = keys(foldRuns(loaded));
  seq = 200;
  const older = [
    row('user', [text('go')]),
    row('assistant', [call('Read', {}, 't02')]),
    row('user', [result('ok')]),
  ];
  const after = keys(foldRuns([...older, ...loaded]));
  for (const k of before) assert.ok(after.includes(k), `prepend lost ${k} — ${after.join(' ')}`);
});

test('...and when the turn below it keeps writing', () => {
  const loaded = startedMidRun();
  const before = keys(foldRuns(loaded));
  seq = 300;
  const after = keys(foldRuns([...loaded, row('assistant', [call('Bash', {}, 't13')])]));
  for (const k of before) assert.ok(after.includes(k), `append lost ${k} — ${after.join(' ')}`);
});

test('a run is named after the row below it, which nothing can move', () => {
  seq = 400;
  const rows = foldRuns([
    row('assistant', [call('Bash', {}, 't1')]),
    row('user', [result('ok')]),
    row('assistant', [text('done')]),
  ]);
  const run = rows.find((r) => r.kind === 'run') as FoldedRun;
  const prose = rows[rows.length - 1];
  assert.equal(run.key, `r>${prose.key}`);
});

// The one run with nothing after it is the one still being written. It keeps a
// sentinel rather than a derived id, because whatever it were derived from is
// the thing that keeps moving while the turn runs.
test('the run still being written is the only one with a sentinel key', () => {
  seq = 500;
  const rows = foldRuns([
    row('user', [text('go')]),
    row('assistant', [call('Bash', {}, 't1')]),
  ]);
  const runs = rows.filter((r) => r.kind === 'run') as FoldedRun[];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].key, OPEN_RUN_KEY);
});

test('two runs in one message get two different names', () => {
  seq = 600;
  const rows = foldRuns([
    row('assistant', [call('Bash', {}, 't1'), text('between'), call('Read', {}, 't2')]),
    row('assistant', [text('after')]),
  ]);
  const runKeys = rows.filter((r) => r.kind === 'run').map((r) => r.key);
  assert.equal(runKeys.length, 2);
  assert.equal(new Set(runKeys).size, 2, runKeys.join(' '));
});

test('every row in a fold has a unique key — the windowing map is keyed on it', () => {
  seq = 700;
  const rows = foldRuns([
    row('user', [text('go')]),
    row('assistant', [call('Bash', {}, 't1'), text('mid'), call('Read', {}, 't2')]),
    row('user', [result('ok'), result('ok')]),
    row('assistant', [text('done')]),
    row('assistant', [call('Bash', {}, 't3')]),
  ]);
  const ks = rows.map((r) => r.key);
  assert.equal(new Set(ks).size, ks.length, ks.join(' '));
});

// --- seams: folding in two halves must equal folding the whole ---------------
//
// This is what makes an incremental fold legal. If it ever stops holding, a long
// session will silently render a different conversation from a short one.

test('a seam splits the fold without changing a single row', () => {
  // Deliberately awkward: runs spanning messages, a message that is machinery
  // then prose, one that is prose then machinery (which leaves a run OPEN and so
  // must never be offered as a seam), a terminator-free tail, and an empty row.
  const msgs = [
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
  const ident = (rows: FoldedRow[]) => rows.map((r) => `${r.kind}:${r.key}:${r.ids.join('+')}`);
  const whole = ident(foldRuns(msgs));
  let seams = 0;
  for (let at = 1; at < msgs.length; at++) {
    const cut = safeSplitIndex(msgs, at);
    if (cut === 0) continue;
    seams++;
    const split = ident([...foldRuns(msgs.slice(0, cut)), ...foldRuns(msgs.slice(cut))]);
    assert.deepEqual(split, whole, `split at ${cut} changed the fold`);
  }
  assert.ok(seams >= 4, `expected several seams in this fixture, found ${seams}`);
});

test('a message that ends mid-run is never offered as a seam', () => {
  // `[text, tool_use]` flushes the prose into a row and then OPENS a run, so the
  // fold still has memory afterwards. Splitting there would cut one capsule in two.
  assert.equal(closesRunUnconditionally(row('assistant', [text('before'), call('Grep')])), false);
  assert.equal(closesRunUnconditionally(row('assistant', [call('Read')])), false);
});

test('a message that ends on something visible is a seam', () => {
  assert.equal(closesRunUnconditionally(row('assistant', [call('Bash'), text('done')])), true);
  assert.equal(closesRunUnconditionally(row('user', [text('hi')])), true);
  assert.equal(closesRunUnconditionally(row('assistant', [call('Read'), image()])), true);
});

test('an empty message is a seam — it still produces a row', () => {
  assert.equal(closesRunUnconditionally(row('user', [])), true);
});

test('with no seam anywhere, the whole list is folded as one', () => {
  const allMachinery = [row('assistant', [call('Read')]), row('user', [result('ok')])];
  assert.equal(safeSplitIndex(allMachinery, 2), 0);
});

test('safeSplitIndex never returns a point past what was asked for', () => {
  const msgs = [row('user', [text('a')]), row('user', [text('b')]), row('user', [text('c')])];
  assert.equal(safeSplitIndex(msgs, 2), 2);
  assert.equal(safeSplitIndex(msgs, 1), 1);
  assert.equal(safeSplitIndex(msgs, 99), 3);
});
