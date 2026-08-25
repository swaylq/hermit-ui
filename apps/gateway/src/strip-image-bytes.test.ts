import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripToolResultImageBytes } from './strip-image-bytes';

const big = 'A'.repeat(20_000);
const small = 'A'.repeat(100);

test('drops a big base64 image nested in a tool_result, keeping the shape', () => {
  const content = [
    { type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
    ] },
  ];
  const out = stripToolResultImageBytes(content) as any[];
  const img = out[0].content[1];
  assert.equal(img.source.data, '');
  assert.equal(img.source.media_type, 'image/png');
  assert.equal(img.source.elidedKB, Math.round(big.length / 1024));
  assert.equal(out[0].content[0].text, 'screenshot taken', 'text in the same tool_result is untouched');
});

test('leaves a TOP-LEVEL image alone — those are displayed', () => {
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }];
  const out = stripToolResultImageBytes(content);
  assert.equal(out, content, 'same reference: nothing changed');
  assert.equal((out as any[])[0].source.data, big);
});

test('leaves a small nested image alone — the shape costs more than the bytes', () => {
  const content = [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: small } }] }];
  assert.equal(stripToolResultImageBytes(content), content);
});

test('url-sourced images are never touched', () => {
  const content = [
    { type: 'tool_result', content: [{ type: 'image', source: { type: 'url', url: '/uploads/s/x.safe.png' } }] },
    { type: 'image', source: { type: 'url', url: '/uploads/s/y.safe.png' } },
  ];
  assert.equal(stripToolResultImageBytes(content), content);
});

test('survives the shapes that are not arrays of blocks', () => {
  assert.equal(stripToolResultImageBytes('plain text'), 'plain text');
  assert.equal(stripToolResultImageBytes(null), null);
  assert.equal(stripToolResultImageBytes(undefined), undefined);
  const s = [{ type: 'tool_result', content: 'stdout here' }];
  assert.equal(stripToolResultImageBytes(s), s);
  const weird = [null, 42, 'x', { type: 'text', text: 'ok' }];
  assert.equal(stripToolResultImageBytes(weird), weird);
});

test('returns the same reference when nothing is droppable, so upserts stay cheap', () => {
  const content = [{ type: 'text', text: 'hello' }];
  assert.equal(stripToolResultImageBytes(content), content);
});
