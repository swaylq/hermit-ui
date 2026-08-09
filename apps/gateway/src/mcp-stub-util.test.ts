import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// mcp-stub-util is a .cjs (the MCP stub is spawned by raw `node`, so its helpers stay
// CommonJS + outside the tsc gate). Load it via createRequire so tsc needs no
// declaration file for the .cjs; cast to the shapes we exercise.
const require = createRequire(import.meta.url);
const { textOf, mimeForExt, buildCronPatch } = require('./mcp-stub-util.cjs') as {
  textOf: (content: unknown) => string;
  mimeForExt: (ext: string) => string;
  buildCronPatch: (args: unknown) => Record<string, unknown>;
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

// buildCronPatch — cron_update's args → the tRPC patch. The stakes here are quiet
// ones: a field that leaks into the patch when the caller never mentioned it
// overwrites a live schedule, and an empty patch reports success while changing
// nothing.
test('buildCronPatch: sends ONLY the fields the caller passed', () => {
  assert.deepEqual(buildCronPatch({ prompt: 'new prompt' }), { prompt: 'new prompt' });
  assert.deepEqual(buildCronPatch({ enabled: false }), { enabled: false });
});

test('buildCronPatch: minutes in, seconds out', () => {
  assert.deepEqual(buildCronPatch({ intervalMinutes: 1440 }), { intervalSec: 86_400 });
  assert.deepEqual(buildCronPatch({ jitterMinutes: 2.5 }), { jitterSec: 150 });
});

test('buildCronPatch: enabled=false survives — it is not "empty"', () => {
  // The trap: `if (args.enabled)` would drop a pause request and then throw
  // "nothing to update" on a call that asked for something real.
  const patch = buildCronPatch({ enabled: false });
  assert.equal(patch.enabled, false);
});

test('buildCronPatch: trims, and ignores blank strings rather than blanking a field', () => {
  assert.deepEqual(buildCronPatch({ prompt: '  spaced  ', title: '   ' }), { prompt: 'spaced' });
  assert.equal(String(buildCronPatch({ title: 'x'.repeat(200) }).title).length, 120);
});

test('buildCronPatch: rejects an empty patch instead of a no-op success', () => {
  assert.throws(() => buildCronPatch({}), /nothing to update/);
  assert.throws(() => buildCronPatch({ id: 'abc' }), /nothing to update/);
  assert.throws(() => buildCronPatch(undefined), /nothing to update/);
});

test('buildCronPatch: rejects out-of-range intervals and junk numbers', () => {
  assert.throws(() => buildCronPatch({ intervalMinutes: 0 }), /intervalMinutes/);
  assert.throws(() => buildCronPatch({ intervalMinutes: 'soon' }), /intervalMinutes/);
  assert.throws(() => buildCronPatch({ jitterMinutes: -1 }), /jitterMinutes/);
});
