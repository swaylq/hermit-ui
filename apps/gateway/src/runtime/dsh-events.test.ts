import test from 'node:test';
import assert from 'node:assert/strict';
import { DshEventTranslator, parseRunnerLine, type DshRunnerLine } from './dsh-events';
import { totalTokens, lastCallUsage } from './dsh-exec';

const SESSION = 'session-abcdef12-3456-7890-abcd-ef1234567890';

function tx() {
  return new DshEventTranslator(SESSION);
}

/** TranslatedItem.content is `unknown` (the sync wire type); narrow for asserts. */
function first(row: { content: unknown }): Record<string, any> {
  return (row.content as Record<string, any>[])[0];
}

// ── the runner protocol ─────────────────────────────────────────────────────

test('parseRunnerLine takes only our lines and leaves dsh noise alone', () => {
  const hello = parseRunnerLine('{"hermit":"hello","sessionId":"session-x","resumed":false,"totals":null}');
  assert.equal((hello as { hermit: string }).hermit, 'hello');
  assert.equal(parseRunnerLine('booting profile headless…'), null);
  assert.equal(parseRunnerLine('{"level":"info","msg":"hermit unrelated"}'), null);
  assert.equal(parseRunnerLine('{broken json "hermit"'), null);
  assert.equal(parseRunnerLine(''), null);
});

// ── assistant messages ──────────────────────────────────────────────────────

test('assistant text and reasoning become their own rows; tool-call blocks are skipped', () => {
  const rows = tx().translate(7, 'assistant/message', {
    turn: 1,
    step: 0,
    message: {
      content: [
        { type: 'reasoning', text: 'thinking it over' },
        { type: 'text', text: 'Here ' },
        { type: 'text', text: 'you go.' },
        // Rendered by the paired tool/call event, not here — both would be a
        // duplicate row.
        { type: 'tool-call', id: 'call_0', name: 'bash', arguments: '{}' },
      ],
    },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].content, [{ type: 'thinking', thinking: 'thinking it over' }]);
  assert.deepEqual(rows[1].content, [{ type: 'text', text: 'Here you go.' }]);
  assert.equal(rows[1].role, 'assistant');
  // Ids are scoped by the dsh session tag so a later dsh session's low seqs
  // cannot overwrite this one's rows.
  assert.equal(rows[1].externalId, 'dsh:abcdef12:7');
  assert.notEqual(rows[0].externalId, rows[1].externalId);
});

test('an empty assistant message produces no rows', () => {
  assert.deepEqual(tx().translate(3, 'assistant/message', { message: { content: [] } }), []);
});

// ── tool calls and results ──────────────────────────────────────────────────

test('a tool call and its result pair up through the callId map', () => {
  const t = tx();
  const call = t.translate(10, 'tool/call', {
    turn: 1, step: 0, callId: 'call_0', name: 'bash', arguments: '{"command":"ls"}',
  });
  assert.equal(call.length, 1);
  const block = first(call[0]);
  assert.equal(block.type, 'tool_use');
  assert.equal(block.name, 'bash');
  assert.deepEqual(block.input, { command: 'ls' });

  const result = t.translate(12, 'tool/result', {
    turn: 1, step: 0,
    message: {
      source: { kind: 'tool', callId: 'call_0' },
      content: [{ type: 'tool-result', toolCallId: 'call_0', content: [{ type: 'text', text: 'file.txt' }] }],
    },
  });
  assert.equal(result.length, 1);
  const res = first(result[0]);
  assert.equal(res.tool_use_id, block.id);
  assert.equal(res.content, 'file.txt');
  assert.equal(res.is_error, false);
  // Its own row — sharing the call's id would make the result replace it.
  assert.notEqual(result[0].externalId, call[0].externalId);
});

test('callIds repeat across turns, so pairing is by the map, not the raw id', () => {
  // dsh callIds are provider-issued and restart per step (call_0, call_0, …) —
  // the same trap as codex's per-turn item ordinals.
  const t = tx();
  t.translate(10, 'tool/call', { callId: 'call_0', name: 'bash', arguments: '{}' });
  t.translate(20, 'tool/call', { callId: 'call_0', name: 'read_file', arguments: '{}' });
  const result = t.translate(21, 'tool/result', {
    message: { source: { kind: 'tool', callId: 'call_0' }, content: [] },
  });
  const res = first(result[0]);
  // The LATEST call_0 wins — its result arrives before any third call_0.
  assert.equal(res.tool_use_id, 'dsh:abcdef12:20');
});

test('a tool failure marks the result row as an error', () => {
  const t = tx();
  t.translate(1, 'tool/call', { callId: 'c', name: 'bash', arguments: '{}' });
  const rows = t.translate(2, 'tool/result', {
    message: { source: { kind: 'tool', callId: 'c' }, content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'boom' }] }] },
    error: { name: 'ExecError', code: 'EXIT_1' },
  });
  assert.equal(first(rows[0]).is_error, true);
});

test('unparseable tool arguments still render, as the raw string', () => {
  const rows = tx().translate(4, 'tool/call', { callId: 'c', name: 'bash', arguments: '{oops' });
  assert.deepEqual(first(rows[0]).input, { arguments: '{oops' });
});

// ── turn endings ────────────────────────────────────────────────────────────

test('a completed turn adds no extra row', () => {
  assert.deepEqual(tx().translate(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), []);
});

test('a failed turn says so — silence reads as being ignored', () => {
  const rows = tx().translate(9, 'turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'system');
  const text = first(rows[0]).text as string;
  assert.match(text, /error/);
  assert.match(text, /MISSING_CREDENTIAL/);
});

test('unknown event types are dropped rather than rendered as empty bubbles', () => {
  assert.deepEqual(tx().translate(1, 'turn/start', { turn: 1 }), []);
  assert.deepEqual(tx().translate(2, 'session/whatever-new', {}), []);
});

// ── usage arithmetic (dsh counts are disjoint) ──────────────────────────────

test('billed input is the sum of uncached input and both cache figures', () => {
  const totals = {
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200,
    last: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 10 },
  };
  assert.equal(totalTokens(totals), 1350);
  assert.deepEqual(lastCallUsage(totals), { contextTokens: 950, outputTokens: 20 });
  assert.equal(totalTokens(null), 0);
  assert.equal(lastCallUsage({ ...totals, last: null }), null);
});

// The runner forwards events verbatim; this pins the line shape the runtime
// parses so a runner edit that changes it fails here, not in production.
test('the event line round-trips through parseRunnerLine', () => {
  const line: DshRunnerLine = { hermit: 'event', seq: 5, type: 'tool/call', data: { callId: 'c' } };
  assert.deepEqual(parseRunnerLine(JSON.stringify(line)), line);
});
