import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateSdkMessage, contextTokensOf,
  applyStreamEvent, newLiveState, liveItem, liveRetraction, liveExternalId,
} from './claude-sdk-events';

const ctx = { sessionId: 'chat1', stampUuid: null, seq: 0 };

const assistant = (uuid: string, content: unknown, usage?: unknown) => ({
  type: 'assistant',
  uuid,
  session_id: 'cc-1',
  message: { role: 'assistant', content, ...(usage ? { usage } : {}) },
  parent_tool_use_id: null,
} as any);

const user = (uuid: string, content: unknown) => ({
  type: 'user', uuid, session_id: 'cc-1',
  message: { role: 'user', content }, parent_tool_use_id: null,
} as any);

// ── assistant turns ─────────────────────────────────────────────────────────

test('an assistant turn becomes one row keyed by its uuid', () => {
  const out = translateSdkMessage(assistant('u-1', [{ type: 'text', text: 'hi' }]), ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].externalId, 'u-1');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'hi' }]);
});

// The content array is forwarded VERBATIM, not re-shaped. The dashboard renders
// Anthropic blocks, and thinking / tool_use are exactly what the pane path put
// in these rows — re-mapping them here is how the two backends would drift.
test('thinking and tool_use blocks pass through untouched', () => {
  const blocks = [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ];
  assert.deepEqual(translateSdkMessage(assistant('u-2', blocks), ctx)[0].content, blocks);
});

test('an assistant message with no content produces nothing', () => {
  assert.deepEqual(translateSdkMessage(assistant('u-3', []), ctx), []);
  assert.deepEqual(translateSdkMessage(assistant('u-4', undefined), ctx), []);
});

// externalId IS the upsert key. A row with no stable id would be re-inserted on
// every replay instead of landing on itself, so it is dropped rather than given
// a random one.
test('an assistant message with no uuid is dropped, not given a random id', () => {
  const noUuid = { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as any;
  assert.deepEqual(translateSdkMessage(noUuid, ctx), []);
});

// ── user records ────────────────────────────────────────────────────────────

test('a tool_result becomes a user row', () => {
  const blocks = [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }];
  const out = translateSdkMessage(user('u-5', blocks), ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].externalId, 'u-5');
});

// The dashboard wrote the user's own row when it accepted the message. Echoing
// it back under the transcript's uuid would show the message twice, once under
// each id — which is exactly what the tmux path is careful not to do.
test('a plain user prompt is NOT echoed back', () => {
  assert.deepEqual(translateSdkMessage(user('u-6', [{ type: 'text', text: 'hello' }]), ctx), []);
  assert.deepEqual(translateSdkMessage(user('u-7', 'hello'), ctx), []);
});

// ── system frames ───────────────────────────────────────────────────────────

test('local command output becomes a fenced system row', () => {
  const out = translateSdkMessage(
    { type: 'system', subtype: 'local_command_output', uuid: 'u-8', content: 'total 0\n' } as any,
    ctx,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.match((out[0].content as any)[0].text, /```\ntotal 0\n```/);
});

test('empty command output produces nothing', () => {
  assert.deepEqual(
    translateSdkMessage({ type: 'system', subtype: 'local_command_output', uuid: 'u-9', content: '   ' } as any, ctx),
    [],
  );
});

test('a compaction boundary is reported with its before/after sizes', () => {
  const out = translateSdkMessage(
    {
      type: 'system', subtype: 'compact_boundary', uuid: 'u-10',
      compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 42_000 },
    } as any,
    ctx,
  );
  assert.equal(out.length, 1);
  assert.match((out[0].content as any)[0].text, /180k → 42k/);
  assert.match((out[0].content as any)[0].text, /手动/);
});

test('init and status frames are not chat rows', () => {
  assert.deepEqual(translateSdkMessage({ type: 'system', subtype: 'init', session_id: 'x' } as any, ctx), []);
  assert.deepEqual(translateSdkMessage({ type: 'system', subtype: 'status', status: 'requesting' } as any, ctx), []);
});

// ── turn outcome ────────────────────────────────────────────────────────────

// The success result restates the final assistant text, which already has its
// own row. Forwarding it would double every reply in the chat.
test('a successful result adds no row', () => {
  assert.deepEqual(
    translateSdkMessage({ type: 'result', subtype: 'success', is_error: false, uuid: 'u-11', result: 'hi' } as any, ctx),
    [],
  );
});

// The pane could not show this at all: a rate limit or API failure appeared only
// on screen, so from the dashboard the turn just stopped with no explanation.
test('a failed result surfaces the reason', () => {
  const out = translateSdkMessage(
    { type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'u-12', result: 'rate limit' } as any,
    ctx,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.match((out[0].content as any)[0].text, /rate limit/);
});

test('a failed result with no message still names its subtype', () => {
  const out = translateSdkMessage(
    { type: 'result', subtype: 'error_max_turns', is_error: true, uuid: 'u-13' } as any, ctx,
  );
  assert.match((out[0].content as any)[0].text, /error_max_turns/);
});

// ── the migration property ──────────────────────────────────────────────────

// This is what makes moving a session between the two claude backends safe in
// BOTH directions. The SDK message and the JSONL record are the same record, so
// feeding either through this translator has to produce the same externalId —
// the sync route upserts on it, so identical ids mean a re-emitted history lands
// on the rows that already exist instead of duplicating the conversation.
test('an SDK message and its transcript record produce the same row', () => {
  const shared = { uuid: 'u-14', message: { role: 'assistant', content: [{ type: 'text', text: 'same' }] } };
  const fromSdk = translateSdkMessage({ type: 'assistant', ...shared, parent_tool_use_id: null } as any, ctx);
  // What `watchTranscript` hands back for the same line: no wrapper fields, the
  // extra transcript-only keys the JSONL carries.
  const fromTail = translateSdkMessage(
    { type: 'assistant', ...shared, parentUuid: 'p', isSidechain: false, timestamp: '2026-08-21T00:00:00Z' } as any,
    ctx,
  );
  assert.deepEqual(fromSdk, fromTail);
  assert.equal(fromSdk[0].externalId, 'u-14');
});

// ── context tokens ──────────────────────────────────────────────────────────

test('context tokens are prompt plus both cache halves', () => {
  const got = contextTokensOf(assistant('u-15', [], {
    input_tokens: 2, cache_creation_input_tokens: 3950, cache_read_input_tokens: 15623, output_tokens: 7,
  }));
  assert.deepEqual(got, { contextTokens: 19575, outputTokens: 7 });
});

// Claude Code answers /context, /status and friends LOCALLY and still emits an
// assistant message — carrying a usage object with every field zero. Measured on
// 2.1.237. Accepting it blanks the context bar of a session that is 20k tokens
// deep, and it stays blank until the next real turn.
test('a locally-answered command does not blank the context bar', () => {
  const zeroed = contextTokensOf(assistant('u-16', [{ type: 'text', text: '## Context Usage' }], {
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
  }));
  assert.equal(zeroed, null, 'a zeroed usage must be rejected, not reported as an empty window');
});

test('a message with no usage reports nothing rather than zero', () => {
  assert.equal(contextTokensOf(assistant('u-17', [{ type: 'text', text: 'x' }])), null);
  assert.equal(contextTokensOf(user('u-18', [])), null);
});

// The boundary is newer than the assistant message before it and states the
// post-compaction size directly — the one case where the newest assistant usage
// is stale by construction.
test('a compaction boundary reports the post-compaction size', () => {
  assert.deepEqual(
    contextTokensOf({ type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: 42_000 } } as any),
    { contextTokens: 42_000, outputTokens: 0 },
  );
  // …and a boundary that does not carry one defers rather than reporting zero.
  assert.equal(
    contextTokensOf({ type: 'system', subtype: 'compact_boundary', compact_metadata: {} } as any),
    null,
  );
});

// ── The live block ───────────────────────────────────────────────────────────

function blockStart(index: number, type: string) {
  return { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type } } } as any;
}
function textDelta(index: number, text: string) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } } as any;
}
function thinkingDelta(index: number, thinking: string) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } } } as any;
}

test('a text block accumulates across deltas', () => {
  const st = newLiveState();
  assert.equal(applyStreamEvent(st, blockStart(0, 'text')), null);
  assert.equal(applyStreamEvent(st, textDelta(0, 'The colo')), 'grew');
  assert.equal(applyStreamEvent(st, textDelta(0, 'ur blue')), 'grew');
  assert.equal(st.block?.text, 'The colour blue');
  assert.deepEqual(liveItem('s1', st.block!).content, [{ type: 'text', text: 'The colour blue' }]);
});

test('a thinking block streams as a thinking block, not as text', () => {
  const st = newLiveState();
  applyStreamEvent(st, blockStart(0, 'thinking'));
  applyStreamEvent(st, thinkingDelta(0, 'weighing it up'));
  assert.deepEqual(liveItem('s1', st.block!).content, [{ type: 'thinking', thinking: 'weighing it up' }]);
});

test('a tool_use block does not stream — half a JSON object is not a message', () => {
  const st = newLiveState();
  applyStreamEvent(st, blockStart(0, 'text'));
  applyStreamEvent(st, textDelta(0, 'hi'));
  assert.equal(applyStreamEvent(st, blockStart(1, 'tool_use')), 'ended', 'and the previous block is retracted');
  assert.equal(st.block, null);
  assert.equal(applyStreamEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } } } as any), null);
});

test('a delta for another block index is ignored', () => {
  const st = newLiveState();
  applyStreamEvent(st, blockStart(1, 'text'));
  assert.equal(applyStreamEvent(st, textDelta(0, 'stale')), null);
  assert.equal(st.block?.text, '');
});

test('block stop and message stop end the live block exactly once', () => {
  const st = newLiveState();
  applyStreamEvent(st, blockStart(0, 'text'));
  applyStreamEvent(st, textDelta(0, 'done'));
  assert.equal(applyStreamEvent(st, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } as any), 'ended');
  assert.equal(st.block, null);
  assert.equal(applyStreamEvent(st, { type: 'stream_event', event: { type: 'message_stop' } } as any), null, 'nothing live, nothing to end');
});

test('an empty delta is not growth', () => {
  const st = newLiveState();
  applyStreamEvent(st, blockStart(0, 'text'));
  assert.equal(applyStreamEvent(st, textDelta(0, '')), null);
});

test('a non-partial message is not the live block’s business', () => {
  const st = newLiveState();
  applyStreamEvent(st, blockStart(0, 'text'));
  applyStreamEvent(st, textDelta(0, 'kept'));
  assert.equal(applyStreamEvent(st, { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'kept' }] } } as any), null);
  assert.equal(st.block?.text, 'kept', 'the caller retracts on the assistant record; the reducer does not');
});

test('the placeholder is one row per session, and its retraction says so', () => {
  assert.equal(liveExternalId('sess-1'), 'sdk-live-sess-1');
  const r = liveRetraction('sess-1');
  assert.equal(r.externalId, 'sdk-live-sess-1');
  assert.equal(r.deleted, true);
  assert.deepEqual(r.content, []);
});
