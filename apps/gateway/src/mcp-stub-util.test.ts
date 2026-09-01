import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// mcp-stub-util is a .cjs (the MCP stub is spawned by raw `node`, so its helpers stay
// CommonJS + outside the tsc gate). Load it via createRequire so tsc needs no
// declaration file for the .cjs; cast to the shapes we exercise.
const require = createRequire(import.meta.url);
const { textOf, mimeForExt, buildCronPatch, resolveMemoryPath, writeMemory } = require('./mcp-stub-util.cjs') as {
  textOf: (content: unknown) => string;
  mimeForExt: (ext: string) => string;
  buildCronPatch: (args: unknown) => Record<string, unknown>;
  resolveMemoryPath: (agentDir: string, rel: string) => string;
  writeMemory: (agentDir: string, args: Record<string, unknown>) => string;
};
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

function tmpAgent(): string {
  return fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), 'chat-only-'));
}

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

// ── resolveMemoryPath — the pure-chat write gate ────────────────────────────
// This is the only path by which a session that has no Write and no shell can
// put bytes on disk, so it is tested as a boundary rather than as a helper:
// every rejection below is a way someone could otherwise have escaped it.

const AGENT = '/agents/asst';

test('accepts the four shapes memory actually takes', () => {
  assert.equal(resolveMemoryPath(AGENT, 'memory/2026-09-01.md'), '/agents/asst/memory/2026-09-01.md');
  assert.equal(resolveMemoryPath(AGENT, 'memory/notes/arch_x.md'), '/agents/asst/memory/notes/arch_x.md');
  assert.equal(resolveMemoryPath(AGENT, 'memory/notes/INDEX.md'), '/agents/asst/memory/notes/INDEX.md');
  assert.equal(resolveMemoryPath(AGENT, 'MEMORY.md'), '/agents/asst/MEMORY.md');
  assert.equal(resolveMemoryPath(AGENT, 'evolution/lessons.md'), '/agents/asst/evolution/lessons.md');
});

test('a traversal is judged by where it LANDS, not by how it is spelled', () => {
  // Lands back inside memory/ — fine, however baroque the route.
  assert.equal(resolveMemoryPath(AGENT, 'memory/notes/../2026-09-01.md'), '/agents/asst/memory/2026-09-01.md');
  assert.equal(resolveMemoryPath(AGENT, 'memory/./notes/y.md'), '/agents/asst/memory/notes/y.md');
  // Lands outside — rejected.
  for (const bad of [
    '../evil.md',
    '../../etc/passwd.md',
    'memory/../../evil.md',
    'memory/../../../../../../tmp/evil.md',
    'memory/notes/../../../evil.md',
  ]) {
    assert.throws(() => resolveMemoryPath(AGENT, bad), /escapes the agent directory/, bad);
  }
});

test('a sibling directory sharing our prefix is still outside', () => {
  // The separator in the startsWith check is what makes this fail; without it
  // /agents/asst-backup reads as "inside /agents/asst".
  assert.throws(() => resolveMemoryPath(AGENT, '../asst-backup/memory/x.md'), /escapes the agent directory/);
});

test('inside the agent dir is not enough — it must be memory', () => {
  for (const bad of ['scripts/x.md', '.claude/settings.md', 'AGENTS.md', 'IDENTITY.md', 'projects/p/notes.md']) {
    assert.throws(() => resolveMemoryPath(AGENT, bad), /may only write memory/, bad);
  }
  // A bare prefix names a directory, not a file.
  assert.throws(() => resolveMemoryPath(AGENT, 'memory/'), /may only write memory/);
  // Close, but not the allowlisted file.
  assert.throws(() => resolveMemoryPath(AGENT, 'memory.md'), /may only write memory/);
});

test('markdown only — so nothing executable can be parked for a later session', () => {
  for (const bad of ['memory/x.sh', 'memory/x.js', 'memory/notes/x.mjs', 'memory/x.md.sh', 'evolution/x.json']) {
    assert.throws(() => resolveMemoryPath(AGENT, bad), /markdown/, bad);
  }
  // Case is not a way around it.
  assert.equal(resolveMemoryPath(AGENT, 'memory/X.MD'), '/agents/asst/memory/X.MD');
});

test('rejects absolute paths, blanks and NUL bytes outright', () => {
  assert.throws(() => resolveMemoryPath(AGENT, '/etc/passwd.md'), /must be relative/);
  assert.throws(() => resolveMemoryPath(AGENT, '/agents/asst/memory/x.md'), /must be relative/);
  assert.throws(() => resolveMemoryPath(AGENT, ''), /path required/);
  assert.throws(() => resolveMemoryPath(AGENT, '   '), /path required/);
  assert.throws(() => resolveMemoryPath(AGENT, 'memory/x' + String.fromCharCode(0) + '.md'), /NUL/);
  assert.throws(() => resolveMemoryPath(AGENT, null as unknown as string), /path required/);
  assert.throws(() => resolveMemoryPath(AGENT, 42 as unknown as string), /path required/);
});

// ── writeMemory — the same gate, plus the filesystem ────────────────────────
// The property under test is not "it writes" but "it cannot destroy": a pure
// chat session is allowed to add to memory and nothing else.

test('append creates the file, then keeps what is already there', () => {
  const dir = tmpAgent();
  const out = writeMemory(dir, { path: 'memory/2026-09-01.md', content: 'first\n' });
  assert.match(out, /appended to memory\/2026-09-01\.md/);
  writeMemory(dir, { path: 'memory/2026-09-01.md', content: 'second\n' });
  assert.equal(fs.readFileSync(nodePath.join(dir, 'memory/2026-09-01.md'), 'utf8'), 'first\nsecond\n');
});

test('prepend puts the new line on top without losing the old ones', () => {
  const dir = tmpAgent();
  writeMemory(dir, { path: 'memory/notes/INDEX.md', content: 'old entry\n' });
  writeMemory(dir, { path: 'memory/notes/INDEX.md', content: 'new entry\n', mode: 'prepend' });
  assert.equal(fs.readFileSync(nodePath.join(dir, 'memory/notes/INDEX.md'), 'utf8'), 'new entry\nold entry\n');
});

test('create makes a new note and refuses to clobber an existing one', () => {
  const dir = tmpAgent();
  writeMemory(dir, { path: 'memory/notes/x.md', content: 'body' , mode: 'create' });
  assert.equal(fs.readFileSync(nodePath.join(dir, 'memory/notes/x.md'), 'utf8'), 'body');
  assert.throws(
    () => writeMemory(dir, { path: 'memory/notes/x.md', content: 'other', mode: 'create' }),
    /already exists/,
  );
});

test('nested directories are created on the way', () => {
  const dir = tmpAgent();
  writeMemory(dir, { path: 'memory/notes/deep/y.md', content: 'hi' });
  assert.ok(fs.existsSync(nodePath.join(dir, 'memory/notes/deep/y.md')));
});

test('a symlinked memory/ cannot be used to write outside the agent', () => {
  const dir = tmpAgent();
  const elsewhere = tmpAgent();
  // memory/ is a symlink to a directory outside the agent — the string gate
  // sees a perfectly ordinary "memory/x.md" and only realpath catches it.
  fs.symlinkSync(elsewhere, nodePath.join(dir, 'memory'));
  assert.throws(() => writeMemory(dir, { path: 'memory/x.md', content: 'escaped' }), /symlink/);
  assert.equal(fs.existsSync(nodePath.join(elsewhere, 'x.md')), false);
});

test('an existing memory file that is a symlink outward is refused too', () => {
  const dir = tmpAgent();
  const elsewhere = tmpAgent();
  const target = nodePath.join(elsewhere, 'target.md');
  fs.writeFileSync(target, 'original\n');
  fs.mkdirSync(nodePath.join(dir, 'memory'));
  fs.symlinkSync(target, nodePath.join(dir, 'memory', 'x.md'));
  assert.throws(() => writeMemory(dir, { path: 'memory/x.md', content: 'appended' }), /symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
});

test('rejects a bad mode and empty content rather than guessing', () => {
  const dir = tmpAgent();
  assert.throws(() => writeMemory(dir, { path: 'memory/x.md', content: 'a', mode: 'overwrite' }), /unknown mode/);
  assert.throws(() => writeMemory(dir, { path: 'memory/x.md', content: '' }), /content required/);
  assert.throws(() => writeMemory('', { path: 'memory/x.md', content: 'a' }), /agent directory unknown/);
});
