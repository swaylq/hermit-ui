import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// mcp-stub-util is a .cjs (the MCP stub is spawned by raw `node`, so its helpers stay
// CommonJS + outside the tsc gate). Load it via createRequire so tsc needs no
// declaration file for the .cjs; cast to the shapes we exercise.
const require = createRequire(import.meta.url);
const { textOf, mimeForExt } = require('./mcp-stub-util.cjs') as {
  textOf: (content: unknown) => string;
  mimeForExt: (ext: string) => string;
};

test('textOf: passes a raw string through unchanged', () => {
  assert.equal(textOf('hello world'), 'hello world');
});

test('textOf: joins text blocks with \\n, drops non-text blocks', () => {
  const content = [
    { type: 'text', text: 'first' },
    { type: 'tool_use', name: 'x', input: {} },
    { type: 'image', source: {} },
    { type: 'text', text: 'second' },
  ];
  assert.equal(textOf(content), 'first\nsecond');
});

test('textOf: trims surrounding whitespace of the joined result', () => {
  assert.equal(textOf([{ type: 'text', text: '  padded  ' }]), 'padded');
});

test('textOf: ignores text blocks whose text is not a string', () => {
  assert.equal(textOf([{ type: 'text', text: 123 }, { type: 'text', text: 'ok' }]), 'ok');
});

test('textOf: non-array, non-string inputs → empty string', () => {
  assert.equal(textOf(null), '');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf({ type: 'text', text: 'x' }), '');
  assert.equal(textOf(42), '');
});

test('textOf: empty array → empty string', () => {
  assert.equal(textOf([]), '');
});

test('mimeForExt: known image + office extensions map to their real MIME', () => {
  assert.equal(mimeForExt('png'), 'image/png');
  assert.equal(mimeForExt('jpg'), 'image/jpeg');
  assert.equal(mimeForExt('jpeg'), 'image/jpeg');
  assert.equal(
    mimeForExt('docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
});

test('mimeForExt: unknown / archive / empty extension → octet-stream', () => {
  assert.equal(mimeForExt('exe'), 'application/octet-stream');
  assert.equal(mimeForExt(''), 'application/octet-stream');
  // archives are NOT in the map — they go up as octet-stream (the upload route's
  // own allowlist validates them), so this documents that boundary.
  assert.equal(mimeForExt('zip'), 'application/octet-stream');
});
