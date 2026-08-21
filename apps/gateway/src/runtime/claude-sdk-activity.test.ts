import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newActivityState, applyActivityMessage, describeActivity,
  bashesRunningLongerThan, elapsedSecOf,
} from './claude-sdk-activity';

const T0 = 1_700_000_000_000;
const at = (sec: number) => T0 + sec * 1000;

const toolUse = (id: string, name: string, input: unknown, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

function stateWith(msgs: Array<[unknown, number]>) {
  const st = newActivityState();
  for (const [m, t] of msgs) applyActivityMessage(st, m, t);
  return st;
}

// ── the tool pair ───────────────────────────────────────────────────────────
//
// tool_use starts, tool_result ends. This is the signal the whole thing rests
// on precisely because it is the one that is always there — `tool_progress`,
// which looks like the obvious input, does not arrive for a plain foreground
// Bash (measured against 2.1.238).

test('a running tool is named, with how long it has been running', () => {
  const st = stateWith([[toolUse('t1', 'Bash', { command: 'npm test' }), at(0)]]);
  const a = describeActivity(st, at(47));
  assert.equal(a?.kind, 'tool');
  assert.equal(a?.label, 'Bash');
  assert.equal(a?.detail, 'npm test');
  assert.equal(a?.elapsedSec, 47);
});

test('a finished tool leaves nothing behind', () => {
  const st = stateWith([
    [toolUse('t1', 'Bash', { command: 'ls' }), at(0)],
    [toolResult('t1'), at(2)],
  ]);
  assert.equal(describeActivity(st, at(3)), null);
});

test('the tool holding the turn up is the OLDEST one, not the newest', () => {
  // Several tools in flight: the one worth naming is the one everything is
  // waiting on, which is the one that started first.
  const st = stateWith([
    [toolUse('slow', 'Bash', { command: 'docker build .' }), at(0)],
    [toolUse('fast', 'Read', { file_path: '/a.ts' }), at(30)],
  ]);
  const a = describeActivity(st, at(40));
  assert.equal(a?.label, 'Bash');
  assert.equal(a?.elapsedSec, 40);
});

test('a subagent’s own tools do not masquerade as the session’s work', () => {
  const st = stateWith([[toolUse('inner', 'Grep', { pattern: 'foo' }, 'parent-1'), at(0)]]);
  assert.equal(describeActivity(st, at(5)), null, 'a sidechain tool is not the foreground');
});

test('the detail is the first line, capped', () => {
  const st = stateWith([[toolUse('t1', 'Bash', { command: `echo one\necho two` }), at(0)]]);
  assert.equal(describeActivity(st, at(1))?.detail, 'echo one');

  const long = stateWith([[toolUse('t2', 'Bash', { command: 'x'.repeat(400) }), at(0)]]);
  const d = describeActivity(long, at(1))?.detail ?? '';
  assert.ok(d.length <= 120, `detail was ${d.length} chars`);
  assert.ok(d.endsWith('…'));
});

test('tools with no recognisable input still report their name', () => {
  const st = stateWith([[toolUse('t1', 'SomeTool', { weird: 1 }), at(0)]]);
  const a = describeActivity(st, at(3));
  assert.equal(a?.label, 'SomeTool');
  assert.equal(a?.detail, undefined);
});

// tool_progress is not required, but when it comes it is more accurate than our
// own clock (it is measured where the tool actually runs).
test('tool_progress sharpens the elapsed time when it arrives', () => {
  const st = stateWith([
    [toolUse('t1', 'Bash', { command: 'x' }), at(0)],
    [{ type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', elapsed_time_seconds: 91 }, at(30)],
  ]);
  assert.equal(describeActivity(st, at(30))?.elapsedSec, 91);
});

// ── precedence ──────────────────────────────────────────────────────────────

// The one state the pane could not report at all: a rate-limited session just
// looked hung. It outranks everything because it is the difference between
// "slow" and "stuck".
test('a rate limit outranks the tool it interrupted', () => {
  const st = stateWith([
    [toolUse('t1', 'Bash', { command: 'x' }), at(0)],
    [{ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 30_000 }, at(10)],
  ]);
  const a = describeActivity(st, at(18));
  assert.equal(a?.kind, 'retrying');
  assert.equal(a?.attempt, 2);
  assert.equal(a?.maxRetries, 5);
  assert.equal(a?.retryInSec, 22, 'counts down from the delay the API asked for');
});

test('the retry countdown floors at zero rather than going negative', () => {
  const st = stateWith([
    [{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 5_000 }, at(0)],
  ]);
  assert.equal(describeActivity(st, at(60))?.retryInSec, 0);
});

test('an assistant frame means the retry is over', () => {
  const st = stateWith([
    [{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 5_000 }, at(0)],
    [toolUse('t1', 'Read', { file_path: '/a' }), at(6)],
  ]);
  assert.equal(describeActivity(st, at(7))?.kind, 'tool');
});

test('compaction is reported, and outranks a tool', () => {
  const st = stateWith([
    [toolUse('t1', 'Bash', { command: 'x' }), at(0)],
    [{ type: 'system', subtype: 'status', status: 'compacting' }, at(1)],
  ]);
  assert.equal(describeActivity(st, at(2))?.kind, 'compacting');
});

// "Which subagent" is the useful altitude; the tool it happens to be on is the
// qualifier, not the headline.
test('a subagent outranks its inner tool and names both', () => {
  const st = stateWith([
    [{ type: 'system', subtype: 'task_started', task_id: 'k1', description: 'review the diff', subagent_type: 'code-reviewer' }, at(0)],
    [{ type: 'system', subtype: 'task_progress', task_id: 'k1', description: 'review the diff', last_tool_name: 'Grep' }, at(5)],
  ]);
  const a = describeActivity(st, at(6));
  assert.equal(a?.kind, 'subagent');
  assert.equal(a?.label, 'code-reviewer');
  assert.match(a?.detail ?? '', /review the diff · Grep/);
});

test('a finished subagent stops being reported', () => {
  const st = stateWith([
    [{ type: 'system', subtype: 'task_started', task_id: 'k1', description: 'x' }, at(0)],
    [{ type: 'system', subtype: 'task_notification', task_id: 'k1', status: 'completed' }, at(9)],
  ]);
  assert.equal(describeActivity(st, at(10)), null);
});

test('thinking is reported only when nothing more specific is', () => {
  const idle = stateWith([[{ type: 'system', subtype: 'status', status: 'requesting' }, at(0)]]);
  assert.equal(describeActivity(idle, at(1))?.kind, 'thinking');

  const busy = stateWith([
    [{ type: 'system', subtype: 'status', status: 'requesting' }, at(0)],
    [toolUse('t1', 'Bash', { command: 'x' }), at(1)],
  ]);
  assert.equal(describeActivity(busy, at(2))?.kind, 'tool');
});

// ── background work ─────────────────────────────────────────────────────────

test('background tasks are counted alongside whatever is in the foreground', () => {
  const st = stateWith([
    [{ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'b1', task_type: 'local_bash', description: 'npm ci' },
      { task_id: 'b2', task_type: 'local_bash', description: 'docker build' },
    ] }, at(0)],
    [toolUse('t1', 'Read', { file_path: '/a' }), at(1)],
  ]);
  const a = describeActivity(st, at(2));
  assert.equal(a?.kind, 'tool');
  assert.equal(a?.backgroundCount, 2);
});

// Nothing in the foreground but work still going on: the session is NOT idle,
// and reporting it as such would be a lie the user acts on.
test('background work alone is still activity', () => {
  const st = stateWith([
    [{ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', description: 'npm ci' }] }, at(0)],
  ]);
  const a = describeActivity(st, at(1));
  assert.equal(a?.kind, 'background');
  assert.equal(a?.backgroundCount, 1);
  assert.equal(a?.detail, 'npm ci');
});

// REPLACE semantics — the payload is the whole live set, so an empty one means
// everything finished, not "no news".
test('an empty background payload clears the set', () => {
  const st = stateWith([
    [{ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', description: 'x' }] }, at(0)],
    [{ type: 'system', subtype: 'background_tasks_changed', tasks: [] }, at(1)],
  ]);
  assert.equal(describeActivity(st, at(2)), null);
});

// ── turn boundaries ─────────────────────────────────────────────────────────

// A tool whose result never arrives (interrupt, crash, backgrounding) would
// otherwise pin the chip forever. The result frame is the backstop.
test('a result frame clears everything the turn was doing', () => {
  const st = stateWith([
    [toolUse('t1', 'Bash', { command: 'x' }), at(0)],
    [{ type: 'system', subtype: 'task_started', task_id: 'k1', description: 'y' }, at(1)],
    [{ type: 'system', subtype: 'status', status: 'requesting' }, at(2)],
    [{ type: 'result', subtype: 'success', is_error: false }, at(3)],
  ]);
  assert.equal(describeActivity(st, at(4)), null);
});

test('an idle session reports nothing at all', () => {
  assert.equal(describeActivity(newActivityState(), at(0)), null);
});

test('garbage on the stream is ignored rather than thrown on', () => {
  const st = newActivityState();
  for (const junk of [null, undefined, 'nope', 42, [], { type: 'assistant' }, { type: 'user', message: {} }]) {
    applyActivityMessage(st, junk, at(0));
  }
  assert.equal(describeActivity(st, at(1)), null);
});

// ── the watchdog's input ────────────────────────────────────────────────────

test('only foreground Bash calls past the threshold are rescue candidates', () => {
  const st = stateWith([
    [toolUse('old', 'Bash', { command: 'docker build .' }), at(0)],
    [toolUse('young', 'Bash', { command: 'ls' }), at(170)],
    [toolUse('read', 'Read', { file_path: '/a' }), at(0)],
    [toolUse('sub', 'Bash', { command: 'x' }, 'parent-1'), at(0)],
  ]);
  const picked = bashesRunningLongerThan(st, 180_000, at(181)).map((t) => t.toolUseId);
  assert.deepEqual(picked, ['old']);
});

test('a tool that has finished is never a rescue candidate', () => {
  const st = stateWith([
    [toolUse('t1', 'Bash', { command: 'x' }), at(0)],
    [toolResult('t1'), at(200)],
  ]);
  assert.deepEqual(bashesRunningLongerThan(st, 180_000, at(400)), []);
});

test('elapsedSecOf never goes negative on a clock that jumped', () => {
  const t = { toolUseId: 'x', name: 'Bash', detail: null, startedAtMs: at(100), parentToolUseId: null };
  assert.equal(elapsedSecOf(t, at(50)), 0);
});
