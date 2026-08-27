import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KimiEventTranslator, parseKimiLine, resumeHintId } from './kimi-code-events';

// Every fixture below is a VERBATIM line captured from
// `kimi -p … --output-format stream-json` (0.38.0) against api.kimi.com/coding.
const VERSION = '{"role":"meta","type":"system.version","version":"0.38.0"}';
const TEXT = '{"role":"assistant","content":"PONG"}';
const CALL = '{"role":"assistant","content":"I replied with exactly: `ENVONLY-OK`","tool_calls":[{"type":"function","id":"tool_g5VNXhJoLDuZfPjQgg78PWk4","function":{"name":"Bash","arguments":"{\\"command\\":\\"echo SECOND-TURN\\"}"}}]}';
const RESULT = '{"role":"tool","tool_call_id":"tool_g5VNXhJoLDuZfPjQgg78PWk4","content":"SECOND-TURN\\n"}';
const HINT = '{"role":"meta","type":"session.resume_hint","session_id":"session_2d0aad4f-7db9-432a-a52c-1bb43dcef343","command":"kimi -r session_2d0aad4f-7db9-432a-a52c-1bb43dcef343","content":"To resume this session: kimi -r …"}';

function parse(line: string) {
  const msg = parseKimiLine(line);
  assert.ok(msg, `expected ${line.slice(0, 40)}… to parse`);
  return msg;
}

// The CLI's own tool output goes to stderr, but a hook, an MCP server or a
// plugin the agent spawns inherits stdout — one stray console.log must not end
// the turn, so anything unparseable is simply not ours.
test('non-JSON stdout is ignored, not fatal', () => {
  assert.equal(parseKimiLine('MARKER-XYZ'), null);
  assert.equal(parseKimiLine(''), null);
  assert.equal(parseKimiLine('{ truncated'), null);
  // Valid JSON, but not a protocol line: no role.
  assert.equal(parseKimiLine('{"hello":"world"}'), null);
});

test('the resume hint is the only line that names the session', () => {
  assert.equal(resumeHintId(parse(HINT)), 'session_2d0aad4f-7db9-432a-a52c-1bb43dcef343');
  assert.equal(resumeHintId(parse(VERSION)), null);
  assert.equal(resumeHintId(parse(TEXT)), null);
});

test('assistant text becomes one text block', () => {
  const rows = new KimiEventTranslator('tag').translate(parse(TEXT));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'assistant');
  assert.deepEqual(rows[0].content, [{ type: 'text', text: 'PONG' }]);
});

// The single most protocol-specific fact here: ONE assistant line carries the
// text the model wrote AND the calls it made in the same step. Reading it as
// one row drops whichever half is read second.
test('one assistant line carrying both halves becomes two rows', () => {
  const rows = new KimiEventTranslator('tag').translate(parse(CALL));
  assert.equal(rows.length, 2);

  assert.deepEqual(rows[0].content, [{ type: 'text', text: 'I replied with exactly: `ENVONLY-OK`' }]);

  const call = (rows[1].content as Record<string, unknown>[])[0];
  assert.equal(call.type, 'tool_use');
  assert.equal(call.name, 'Bash');
  // `function.arguments` is a JSON-encoded STRING on the wire; the renderer
  // wants the object.
  assert.deepEqual(call.input, { command: 'echo SECOND-TURN' });
  // kimi's own call id doubles as the tool_use id so the result matches with no
  // lookup table.
  assert.equal(call.id, 'tool_g5VNXhJoLDuZfPjQgg78PWk4');
});

test('a tool result points back at the call by kimi own id', () => {
  const t = new KimiEventTranslator('tag');
  t.translate(parse(CALL));
  const rows = t.translate(parse(RESULT));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'user');
  assert.deepEqual(rows[0].content, [{
    type: 'tool_result',
    tool_use_id: 'tool_g5VNXhJoLDuZfPjQgg78PWk4',
    content: 'SECOND-TURN\n',
    is_error: false,
  }]);
});

// A model that emitted broken JSON is still worth showing: an empty {} would
// hide the bug in the one place it is visible.
test('unparseable tool arguments are kept verbatim', () => {
  const rows = new KimiEventTranslator('tag').translate(parse(
    '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_x","function":{"name":"Bash","arguments":"{oops"}}]}',
  ));
  const call = (rows[0].content as Record<string, unknown>[])[0];
  assert.deepEqual(call.input, { arguments: '{oops' });
});

test('bookkeeping meta lines stay out of the chat', () => {
  const t = new KimiEventTranslator('tag');
  assert.deepEqual(t.translate(parse(VERSION)), []);
  assert.deepEqual(t.translate(parse(HINT)), []);
});

// A retry IS worth showing: it is the difference between a session that looks
// hung and one that is waiting out a 429.
test('a retry is reported, with its status and its wait', () => {
  const rows = new KimiEventTranslator('tag').translate(parse(
    '{"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,"max_attempts":3,"delay_ms":1500,"error_name":"RateLimit","error_message":"too many requests","status_code":429}',
  ));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'system');
  const text = String((rows[0].content as Record<string, unknown>[])[0].text);
  assert.match(text, /429/);
  assert.match(text, /attempt 1\/3/);
  assert.match(text, /1\.5s/);
  assert.match(text, /too many requests/);
});

// The dashboard upserts on (sessionId, externalId), so a collision inside one
// turn silently overwrites a row.
test('every row of a turn gets its own id', () => {
  const t = new KimiEventTranslator('turn1');
  const ids = [
    ...t.translate(parse(CALL)),
    ...t.translate(parse(RESULT)),
    ...t.translate(parse(TEXT)),
  ].map((r) => r.externalId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^kimi:turn1:/);
});

// An unknown role renders as an empty bubble, which reads as data loss rather
// than as a newer CLI.
test('an unrecognised role is dropped', () => {
  assert.deepEqual(new KimiEventTranslator('tag').translate(parse('{"role":"system","content":"x"}')), []);
});
