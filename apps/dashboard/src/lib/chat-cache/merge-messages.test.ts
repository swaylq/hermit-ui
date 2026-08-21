import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMessagePush, type CachedMsg } from './merge-messages';

type Row = CachedMsg & { id: string };
function row(id: string, text: string, at = 1000): Row {
  return { id, role: 'assistant', content: [{ type: 'text', text }], createdAt: new Date(at).toISOString() };
}

test('an empty cache takes the push as-is', () => {
  const out = applyMessagePush<Row>(undefined, [row('a', 'x', 1), row('b', 'y', 2)]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
});

test('a delta appends without dropping what it did not mention', () => {
  const prev = [row('a', 'x', 1), row('b', 'y', 2)];
  const out = applyMessagePush(prev, [row('c', 'z', 3)]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
});

test('a delta that grows a row replaces only that row, by reference', () => {
  const prev = [row('a', 'x', 1), row('b', 'y', 2)];
  const out = applyMessagePush(prev, [row('b', 'yy', 2)]);
  assert.equal(out.length, 2);
  assert.equal(out[0], prev[0], 'untouched row keeps its object');
  assert.notEqual(out[1], prev[1], 'grown row is the new object');
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'yy' }]);
});

test('a push that changes nothing hands back the same array', () => {
  const prev = [row('a', 'x', 1), row('b', 'y', 2)];
  const out = applyMessagePush(prev, [row('b', 'y', 2)]);
  assert.equal(out, prev, 'same reference, so memo(MessageTimeline) can bail');
});

test('a whole-window push is just a delta that mentions every row', () => {
  const prev = [row('a', 'x', 1), row('b', 'y', 2)];
  const out = applyMessagePush(prev, [row('a', 'x', 1), row('b', 'y', 2), row('c', 'z', 3)]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(out[0], prev[0]);
  assert.equal(out[1], prev[1]);
});

test('gone removes a row the stream can no longer see', () => {
  const prev = [row('a', 'x', 1), row('b', 'y', 2), row('c', 'z', 3)];
  const out = applyMessagePush(prev, [row('d', 'w', 4)], ['a']);
  assert.deepEqual(out.map((r) => r.id), ['b', 'c', 'd']);
});

test('gone wins over a row mentioned in the same push', () => {
  // The live row a turn streams into is deleted in the same batch that inserts
  // the finished one; the client must not resurrect it.
  const prev = [row('live', 'partial', 5)];
  const out = applyMessagePush(prev, [row('live', 'partial', 5), row('real', 'finished', 6)], ['live']);
  assert.deepEqual(out.map((r) => r.id), ['real']);
});

test('gone applies to an empty cache too', () => {
  const out = applyMessagePush<Row>([], [row('a', 'x', 1), row('b', 'y', 2)], ['b']);
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

test('rows land in server order — createdAt, then id', () => {
  const prev = [row('b', 'x', 10)];
  const out = applyMessagePush(prev, [row('a', 'y', 5), row('c', 'z', 10)]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c'], 'a is older; b and c tie and break on id');
});

test('a Date createdAt sorts against a string one', () => {
  const prev: Row[] = [{ id: 'b', role: 'assistant', content: [], createdAt: new Date(2000) }];
  const out = applyMessagePush(prev, [row('a', 'y', 1000)]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
});

test('a role change counts as a change even when the content matches', () => {
  const prev = [row('a', 'x', 1)];
  const out = applyMessagePush(prev, [{ ...row('a', 'x', 1), role: 'user' }]);
  assert.notEqual(out[0], prev[0]);
  assert.equal(out[0].role, 'user');
});
