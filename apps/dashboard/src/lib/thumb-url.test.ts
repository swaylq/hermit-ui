import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbUrlFor, thumbSourceCandidates, THUMB_SUFFIX } from './thumb-url';

test('derives a thumbnail url for every image extension we thumbnail', () => {
  assert.equal(thumbUrlFor('/uploads/sid1/abc.safe.png'), '/uploads/sid1/abc.thumb.webp');
  assert.equal(thumbUrlFor('/uploads/sid1/abc.safe.jpg'), '/uploads/sid1/abc.thumb.webp');
  assert.equal(thumbUrlFor('/uploads/sid1/abc.safe.jpeg'), '/uploads/sid1/abc.thumb.webp');
  assert.equal(thumbUrlFor('/uploads/sid1/abc.safe.webp'), '/uploads/sid1/abc.thumb.webp');
  assert.equal(thumbUrlFor('/uploads/sid1/ABC.SAFE.PNG'), '/uploads/sid1/ABC.thumb.webp');
});

test('refuses everything that is not a thumbnail-able upload', () => {
  // animated gif: a webp re-encode is not an improvement
  assert.equal(thumbUrlFor('/uploads/sid1/abc.safe.gif'), null);
  // the un-resized original is never linked, and must not be rewritten either
  assert.equal(thumbUrlFor('/uploads/sid1/abc.png'), null);
  // base64 tool_result images arrive as data: urls
  assert.equal(thumbUrlFor('data:image/png;base64,iVBORw0KGgo='), null);
  // non-image attachments and other hosts
  assert.equal(thumbUrlFor('/uploads/sid1/report.safe.pdf'), null);
  assert.equal(thumbUrlFor('https://example.com/a.safe.png'), null);
  // no path traversal into another session's directory
  assert.equal(thumbUrlFor('/uploads/sid1/../sid2/abc.safe.png'), null);
  assert.equal(thumbUrlFor(''), null);
});

test('thumbnail url is idempotent — a thumbnail is not itself thumbnail-able', () => {
  const once = thumbUrlFor('/uploads/sid1/abc.safe.png');
  assert.ok(once);
  assert.equal(thumbUrlFor(once), null);
});

test('source candidates cover every extension, in preference order', () => {
  assert.deepEqual(thumbSourceCandidates('/var/hermit-ui/uploads/sid1/abc.thumb.webp'), [
    '/var/hermit-ui/uploads/sid1/abc.safe.png',
    '/var/hermit-ui/uploads/sid1/abc.safe.jpg',
    '/var/hermit-ui/uploads/sid1/abc.safe.jpeg',
    '/var/hermit-ui/uploads/sid1/abc.safe.webp',
  ]);
  assert.deepEqual(thumbSourceCandidates('/var/hermit-ui/uploads/sid1/abc.safe.png'), []);
  assert.equal(THUMB_SUFFIX, '.thumb.webp');
});
