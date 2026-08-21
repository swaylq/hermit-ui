import assert from 'node:assert/strict';
import test from 'node:test';
import { foldRuns, summarizeRun, isMachineryBlock, type FoldedRow, type FoldedRun, type FoldedMsg } from './fold-runs';

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
