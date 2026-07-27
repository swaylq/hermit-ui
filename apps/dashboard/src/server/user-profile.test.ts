// The USER.md corpus filter. This is the test that matters most in the takeover
// feature: if it ever loosens, the Brain starts reading its OWN takeover messages
// and the gateway's pokes back as things the human said, summarises that into
// USER.md, and then acts on it. The drift is silent and compounding — nothing
// crashes, the Brain just gradually becomes a portrait of itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpusQuery, shapeRows, HUMAN_MESSAGES_MAX, MAX_TEXT, type CorpusRow } from './user-profile';

const row = (text: string, at = new Date('2026-07-27T10:00:00Z')): CorpusRow => ({
  createdAt: at,
  sessionId: 's1',
  content: [{ type: 'text', text }],
  session: { agentName: 'asst' },
});

test('the query keeps all four guards on the corpus', () => {
  const { where } = corpusQuery('m1');
  assert.equal(where.role, 'user', 'assistant/tool/system rows are not the human');
  assert.equal(where.authoredBy, null, "excludes the Brain's takeover messages and gateway pokes");
  assert.equal(where.externalId, null, 'excludes transcript rows the gateway synced back');
  assert.equal(where.session.origin, null, 'excludes whole dispatch conversations');
  assert.equal(where.session.machineId, 'm1', 'never reads another machine');
});

test('omitting `since` scans from the beginning rather than defaulting to a window', () => {
  assert.equal('createdAt' in corpusQuery('m1').where, false);
});

test('`since` becomes a strict greater-than, so the watermark row is not re-read', () => {
  const since = new Date('2026-07-01T00:00:00Z');
  assert.deepEqual(corpusQuery('m1', { since }).where.createdAt, { gt: since });
});

test('a null `since` is treated as "no watermark", not as a filter', () => {
  // USER.md's seeded watermark is the literal string `never`; the tool maps that to
  // null, and null must scan from the beginning rather than produce `gt: null`.
  assert.equal('createdAt' in corpusQuery('m1', { since: null }).where, false);
});

test('results are oldest-first so a backlog is absorbed, not truncated to the newest slice', () => {
  assert.deepEqual(corpusQuery('m1').orderBy, { createdAt: 'asc' });
});

test('the limit is clamped to a sane range', () => {
  assert.equal(corpusQuery('m1').take, 200, 'default');
  assert.equal(corpusQuery('m1', { limit: 9_999 }).take, HUMAN_MESSAGES_MAX, 'a huge limit is capped');
  assert.equal(corpusQuery('m1', { limit: 0 }).take, 1, 'zero floors at 1');
  assert.equal(corpusQuery('m1', { limit: -5 }).take, 1, 'negative floors at 1');
});

test('prose is returned with the agent and session it came from', () => {
  const out = shapeRows([row('ship it')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'ship it');
  assert.equal(out[0].agent, 'asst');
  assert.equal(out[0].sessionId, 's1');
});

test('image-only / attachment-only messages are dropped, not returned blank', () => {
  const out = shapeRows([
    { ...row(''), content: [{ type: 'image', source: { url: 'x' } }] },
    row('actual words'),
  ]);
  assert.deepEqual(out.map((m) => m.text), ['actual words']);
});

test('a long paste is truncated — a pasted log says nothing about how someone decides', () => {
  const [only] = shapeRows([row('fix this:\n' + 'x'.repeat(5_000))]);
  assert.ok(only.text.length <= MAX_TEXT + 1, `got ${only.text.length}`);
  assert.ok(only.text.startsWith('fix this:'), 'keeps the head — the instruction is at the front');
  assert.ok(only.text.endsWith('…'));
});

test('a message exactly at the truncation boundary is left alone', () => {
  const [only] = shapeRows([row('y'.repeat(MAX_TEXT))]);
  assert.equal(only.text.length, MAX_TEXT);
  assert.ok(!only.text.endsWith('…'));
});

test('order is preserved through shaping', () => {
  const out = shapeRows([
    row('first', new Date('2026-07-01T00:00:00Z')),
    row('second', new Date('2026-07-02T00:00:00Z')),
  ]);
  assert.deepEqual(out.map((m) => m.text), ['first', 'second']);
});
