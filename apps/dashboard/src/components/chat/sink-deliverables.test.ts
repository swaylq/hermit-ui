import assert from 'node:assert/strict';
import test from 'node:test';
import { sinkDeliverables, isAskToolUse, isAttachmentRow, SINK_IMAGES } from './sink-deliverables';

const DAY = '2026-08-13T10:00:00.000Z';
const NEXT_DAY = '2026-08-14T10:00:00.000Z';

let seq = 0;
const row = (role: string, content: unknown[], createdAt = DAY) => ({
  id: `m${++seq}`,
  role,
  content,
  createdAt,
});

const text = (t: string) => ({ type: 'text', text: t });
const file = (name: string) => ({ type: 'file', name, source: { type: 'url', url: `/uploads/${name}` } });
const image = () => ({ type: 'image', source: { type: 'url', url: '/uploads/shot.png' } });
const askCall = (question: string, name = 'mcp__hermit__ask') => ({
  type: 'tool_use',
  id: 'tu1',
  name,
  input: { question, options: [{ label: 'a' }] },
});
const card = (question: string, status = 'pending') => ({
  type: 'interaction',
  interactionId: 'i1',
  kind: 'question',
  payload: { question, options: [] },
  status,
});

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).join(',');

test('a mid-turn attachment sinks below the final reply', () => {
  const a = row('assistant', [text('building the report…')]);
  const f = row('assistant', [file('report.pdf')]);
  const b = row('assistant', [text('done — 14 rows, 2 flagged')]);
  assert.equal(ids(sinkDeliverables([a, f, b])), `${a.id},${b.id},${f.id}`);
});

test('an attachment that beat its own caption text still sinks', () => {
  // The 120ms sync debounce can stamp the attach row BEFORE the assistant text
  // that introduces it — the worst version of the bug.
  const f = row('assistant', [file('report.pdf')]);
  const a = row('assistant', [text('here is the report')]);
  assert.equal(ids(sinkDeliverables([f, a])), `${a.id},${f.id}`);
});

test('a turn boundary stops the sink — an attachment never crosses into a later turn', () => {
  const f = row('assistant', [file('a.csv')]);
  const u = row('user', [text('thanks, now do the other one')]);
  const a = row('assistant', [text('on it')]);
  assert.equal(ids(sinkDeliverables([f, u, a])), `${f.id},${u.id},${a.id}`);
});

test('an unanswered card sinks below both the prose and the files', () => {
  const a = row('assistant', [text('two ways to do this')]);
  const f = row('assistant', [file('diff.patch')]);
  const q = row('assistant', [text('which one?'), askCall('which one?')]);
  const later = row('assistant', [text('(still thinking)')]);
  const ordered = sinkDeliverables([q, a, f, later], (x) => x === 'which one?');
  assert.equal(ids(ordered), `${a.id},${later.id},${f.id},${q.id}`);
});

test('an ANSWERED card stays where it was asked', () => {
  const q = row('assistant', [text('which one?'), askCall('which one?')]);
  const a = row('assistant', [text('going with the first')]);
  assert.equal(ids(sinkDeliverables([q, a], () => false)), `${q.id},${a.id}`);
});

test('a standalone pending card sinks even with no ask tool_use in the window', () => {
  // Permission prompts, and asks whose call site paged out.
  const c = row('system', [card('approve?')]);
  const a = row('assistant', [text('waiting on you')]);
  assert.equal(ids(sinkDeliverables([c, a])), `${a.id},${c.id}`);
});

test('nothing is reordered across a day divider', () => {
  const f = row('assistant', [file('a.csv')], DAY);
  const a = row('assistant', [text('next morning')], NEXT_DAY);
  assert.equal(ids(sinkDeliverables([f, a])), `${f.id},${a.id}`);
});

test('a turn with no deliverables is returned untouched', () => {
  const rows = [row('user', [text('hi')]), row('assistant', [text('hello')]), row('assistant', [text('more')])];
  assert.equal(ids(sinkDeliverables(rows)), ids(rows));
});

test('isAttachmentRow: a caption travels with its file, prose does not match', () => {
  assert.equal(isAttachmentRow(row('assistant', [text('the report'), file('r.pdf')])), true);
  assert.equal(isAttachmentRow(row('assistant', [text('just prose')])), false);
  assert.equal(isAttachmentRow(row('assistant', [])), false);
  // A user's own upload is an inbound message, never a deliverable to re-sort.
  assert.equal(isAttachmentRow(row('user', [file('mine.pdf')])), false);
  // Mixed with a tool call → it's a real assistant turn, not an attach row.
  assert.equal(isAttachmentRow(row('assistant', [file('r.pdf'), askCall('q')])), false);
});

test('isAttachmentRow follows the SINK_IMAGES policy', () => {
  assert.equal(isAttachmentRow(row('assistant', [text('before/after'), image()])), SINK_IMAGES);
});

test('isAskToolUse matches the pi extension bare name, not just the MCP one', () => {
  assert.equal(isAskToolUse(askCall('q', 'mcp__hermit__ask')), true);
  assert.equal(isAskToolUse(askCall('q', 'ask')), true);
  assert.equal(isAskToolUse(askCall('q', 'hermit/ask')), true);
  assert.equal(isAskToolUse({ type: 'tool_use', name: 'ask', input: {} }), false);
  assert.equal(isAskToolUse({ type: 'tool_use', name: 'Read', input: { question: 'q' } }), false);
  assert.equal(isAskToolUse(text('ask')), false);
  assert.equal(isAskToolUse(null), false);
});

test('a pi session sinks its card too — bare `ask` is recognised', () => {
  const q = row('assistant', [text('pick one'), askCall('pick one', 'ask')]);
  const a = row('assistant', [text('meanwhile…')]);
  assert.equal(ids(sinkDeliverables([q, a], (x) => x === 'pick one')), `${a.id},${q.id}`);
});
