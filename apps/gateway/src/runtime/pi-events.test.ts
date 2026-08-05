import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePiEvent } from './pi-events';

test('assistant message_end becomes text blocks', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  } as any, 'entry-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'hi' }]);
  assert.equal(out[0].externalId, 'entry-1');
});

test('thinking blocks are preserved', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }],
    },
  } as any, 'e2');
  assert.deepEqual(out[0].content, [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'ok' },
  ]);
});

test('tool calls become tool_use blocks', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
    },
  } as any, 'e3');
  assert.deepEqual(out[0].content, [
    { type: 'tool_use', id: 'tc1', name: 'bash', input: { command: 'ls' } },
  ]);
});

test('tool results become a user-role tool_result block', () => {
  const out = translatePiEvent({
    type: 'tool_execution_end',
    toolCallId: 'tc1',
    toolName: 'bash',
    isError: false,
    result: { content: [{ type: 'text', text: 'file.txt' }] },
  } as any, 'e4');
  assert.equal(out[0].role, 'user');
  assert.deepEqual(out[0].content, [
    { type: 'tool_result', tool_use_id: 'tc1', content: 'file.txt', is_error: false },
  ]);
});

test('a failing tool result carries is_error', () => {
  const out = translatePiEvent({
    type: 'tool_execution_end',
    toolCallId: 'tc2',
    isError: true,
    result: 'boom',
  } as any, 'e4b');
  assert.deepEqual(out[0].content, [
    { type: 'tool_result', tool_use_id: 'tc2', content: 'boom', is_error: true },
  ]);
});

test('events with no renderable content produce nothing', () => {
  assert.deepEqual(translatePiEvent({ type: 'agent_settled' } as any, 'e5'), []);
  assert.deepEqual(
    translatePiEvent({ type: 'message_end', message: { role: 'assistant', content: [] } } as any, 'e6'),
    [],
  );
  assert.deepEqual(translatePiEvent(null as any, 'e6b'), []);
});

test('user messages are dropped — the dashboard already wrote that row', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  } as any, 'e7');
  assert.deepEqual(out, []);
});

test('empty text blocks are dropped but siblings survive', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '' }, { type: 'text', text: 'real' }],
    },
  } as any, 'e8');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'real' }]);
});

// pi encodes a failed model call as the final assistant message, with
// stopReason 'error' and an errorMessage — usually carrying no content at all.
// Translating only `content` therefore dropped the entire turn: the user sent a
// message, the provider 429'd, and the chat showed nothing at all.
test('a failed turn is reported instead of vanishing', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'rate limit exceeded (429)',
    },
  } as any, 'e10');

  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.match(JSON.stringify(out[0].content), /rate limit exceeded \(429\)/);
  assert.notEqual(out[0].externalId, 'e10', 'must not collide with the assistant row for the same event');
});

test('partial output survives alongside the error note', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'I started to answ' }],
      stopReason: 'error',
      errorMessage: 'connection reset',
    },
  } as any, 'e11');

  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'I started to answ' }]);
  assert.equal(out[1].role, 'system');
});

test('an aborted turn reads as interrupted, not as a failure', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'aborted' },
  } as any, 'e12');

  assert.equal(out.length, 1);
  assert.match(JSON.stringify(out[0].content), /interrupted/);
});

test('a normal stop reason adds no note', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
  } as any, 'e13');

  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
});

test('unknown block types are skipped rather than passed through raw', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'someFutureBlock', payload: 1 }, { type: 'text', text: 'kept' }],
    },
  } as any, 'e9');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'kept' }]);
});
