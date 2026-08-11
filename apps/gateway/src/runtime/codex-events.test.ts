import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateCodexEvent } from './codex-events';

const completed = (item: unknown) => ({ type: 'item.completed', item } as any);

test('an agent message becomes a text block', () => {
  const out = translateCodexEvent(
    completed({ id: 'item_0', type: 'agent_message', text: 'hi' }),
    'k1',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'hi' }]);
  assert.equal(out[0].externalId, 'k1-item_0');
});

test('reasoning becomes a thinking block', () => {
  const out = translateCodexEvent(
    completed({ id: 'item_1', type: 'reasoning', text: 'hmm' }),
    'k1',
  );
  assert.deepEqual(out[0].content, [{ type: 'thinking', thinking: 'hmm' }]);
});

// The reason this module takes a turnKey at all. Codex ids restart at item_0
// every turn, and the sync route upserts on (sessionId, externalId), so two
// turns sharing an id would leave the chat showing only the newest one.
test('the same codex id in two turns produces two distinct rows', () => {
  const a = translateCodexEvent(completed({ id: 'item_0', type: 'agent_message', text: 'first' }), 'turn-a');
  const b = translateCodexEvent(completed({ id: 'item_0', type: 'agent_message', text: 'second' }), 'turn-b');
  assert.notEqual(a[0].externalId, b[0].externalId);
});

test('a command becomes a tool_use plus its tool_result', () => {
  const out = translateCodexEvent(
    completed({
      id: 'item_1',
      type: 'command_execution',
      command: 'echo hi',
      aggregated_output: 'hi\n',
      exit_code: 0,
      status: 'completed',
    }),
    'k1',
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].content, [
    { type: 'tool_use', id: 'k1-item_1', name: 'Bash', input: { command: 'echo hi' } },
  ]);
  assert.equal(out[1].role, 'user');
  assert.deepEqual(out[1].content, [
    { type: 'tool_result', tool_use_id: 'k1-item_1', content: 'hi\n', is_error: false },
  ]);
  // Two rows, so two ids — sharing one would make the result replace the call.
  assert.notEqual(out[0].externalId, out[1].externalId);
});

test('a non-zero exit is a failed tool_result', () => {
  const out = translateCodexEvent(
    completed({
      id: 'item_1',
      type: 'command_execution',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
      status: 'completed',
    }),
    'k1',
  );
  assert.equal((out[1].content as any)[0].is_error, true);
});

// A command killed by a signal reports failed with no exit code at all.
test('status failed is an error even without an exit code', () => {
  const out = translateCodexEvent(
    completed({ id: 'item_2', type: 'command_execution', command: 'sleep 99', aggregated_output: '', status: 'failed' }),
    'k1',
  );
  assert.equal((out[1].content as any)[0].is_error, true);
});

// So a long-running command is visible while it runs. Same externalId as the
// completed row, so the dashboard upserts rather than showing it twice.
test('a started command emits the call row and no result yet', () => {
  const started = translateCodexEvent(
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'sleep 5', aggregated_output: '', status: 'in_progress' } } as any,
    'k1',
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].role, 'assistant');
  assert.equal(started[0].externalId, 'k1-item_1');
});

// The streaming deltas arrive as item.updated carrying the text so far; syncing
// each would rewrite the row on every token.
test('a partial agent message is not synced', () => {
  const out = translateCodexEvent(
    { type: 'item.updated', item: { id: 'item_0', type: 'agent_message', text: 'par' } } as any,
    'k1',
  );
  assert.deepEqual(out, []);
});

test('a patch reports the files it touched', () => {
  const out = translateCodexEvent(
    completed({
      id: 'item_3',
      type: 'file_change',
      changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }],
      status: 'completed',
    }),
    'k1',
  );
  assert.equal((out[0].content as any)[0].name, 'apply_patch');
  assert.equal((out[1].content as any)[0].content, 'update a.ts\nadd b.ts');
  assert.equal((out[1].content as any)[0].is_error, false);
});

test('an mcp call keeps the mcp__server__tool naming', () => {
  const out = translateCodexEvent(
    completed({
      id: 'item_4',
      type: 'mcp_tool_call',
      server: 'hermit',
      tool: 'ask',
      arguments: { q: 1 },
      result: { content: [{ type: 'text', text: 'answered' }] },
      status: 'completed',
    }),
    'k1',
  );
  assert.equal((out[0].content as any)[0].name, 'mcp__hermit__ask');
  assert.equal((out[1].content as any)[0].content, 'answered');
});

test('an mcp error is a failed result', () => {
  const out = translateCodexEvent(
    completed({
      id: 'item_4',
      type: 'mcp_tool_call',
      server: 's',
      tool: 't',
      arguments: {},
      error: { message: 'boom' },
      status: 'failed',
    }),
    'k1',
  );
  assert.equal((out[1].content as any)[0].content, 'boom');
  assert.equal((out[1].content as any)[0].is_error, true);
});

// Without this the user sends a message, the turn dies, and the chat shows
// nothing at all — which reads as the agent ignoring them.
test('a failed turn is reported into the chat', () => {
  const out = translateCodexEvent({ type: 'turn.failed', error: { message: 'rate limited' } } as any, 'k1');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.match((out[0].content as any)[0].text, /rate limited/);
});

test('a failed turn with no message still says something', () => {
  const out = translateCodexEvent({ type: 'turn.failed', error: {} } as any, 'k1');
  assert.match((out[0].content as any)[0].text, /no error message reported/);
});

test('a stream error is reported into the chat', () => {
  const out = translateCodexEvent({ type: 'error', message: 'stream died' } as any, 'k1');
  assert.equal(out[0].role, 'system');
  assert.match((out[0].content as any)[0].text, /stream died/);
});

// The runtime reads these off the event directly; they carry no chat content.
test('thread and turn lifecycle events produce no rows', () => {
  assert.deepEqual(translateCodexEvent({ type: 'thread.started', thread_id: 'x' } as any, 'k1'), []);
  assert.deepEqual(translateCodexEvent({ type: 'turn.started' } as any, 'k1'), []);
  assert.deepEqual(
    translateCodexEvent({ type: 'turn.completed', usage: { input_tokens: 1 } } as any, 'k1'),
    [],
  );
});

test('an empty agent message is dropped rather than synced blank', () => {
  assert.deepEqual(translateCodexEvent(completed({ id: 'item_0', type: 'agent_message', text: '' }), 'k1'), []);
});

// An unrecognised block reaching the dashboard renders as an empty bubble,
// which looks like data loss rather than a new codex feature.
test('an unknown item type is dropped', () => {
  assert.deepEqual(translateCodexEvent(completed({ id: 'item_9', type: 'something_new' }), 'k1'), []);
});
