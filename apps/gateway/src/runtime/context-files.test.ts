import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandImports, globalMemoryPrompt, MAX_CONTEXT_CHARS } from './context-files';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-files-'));
}

function write(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

// This is the whole point on this fleet: global memory is a heading plus ONE
// @import line, so handing pi the file verbatim would inherit nothing that
// matters. Measured on sway003 — the entire body was
// `@/Users/sway003/.claude/global-memory/secrets-usage.md`.
test('an @import is replaced by the file it names', () => {
  const dir = tmpdir();
  write(dir, 'secrets.md', 'use `secret exec`, never echo the value');
  const md = write(dir, 'CLAUDE.md', `# Global Memory\n\n@${path.join(dir, 'secrets.md')}\n`);

  const out = globalMemoryPrompt(md);
  assert.match(out, /# Global Memory/);
  assert.match(out, /secret exec/);
  assert.ok(!out.includes(`@${dir}`), 'the literal import line must be gone');
});

test('imports nest, and a relative import resolves against its own file', () => {
  const dir = tmpdir();
  write(dir, 'deep/leaf.md', 'LEAF-CONTENT');
  write(dir, 'deep/mid.md', '@./leaf.md');
  const md = write(dir, 'CLAUDE.md', `@${path.join(dir, 'deep', 'mid.md')}`);

  assert.match(globalMemoryPrompt(md), /LEAF-CONTENT/);
});

// Two notes referencing each other must not hang the gateway or produce a
// prompt the size of the disk.
test('a cycle terminates instead of expanding forever', () => {
  const dir = tmpdir();
  write(dir, 'a.md', `A-START\n@${path.join(dir, 'b.md')}`);
  write(dir, 'b.md', `B-START\n@${path.join(dir, 'a.md')}`);
  const md = write(dir, 'CLAUDE.md', `@${path.join(dir, 'a.md')}`);

  const out = globalMemoryPrompt(md);
  assert.match(out, /A-START/);
  assert.match(out, /B-START/);
  assert.equal(out.split('A-START').length - 1, 1, 'a.md must be inlined exactly once');
});

// Deleting it would hide a broken memory file; the literal line at least shows
// up in the prompt where someone can notice it.
test('an import that cannot be read is left as its literal line', () => {
  const dir = tmpdir();
  const missing = path.join(dir, 'nope.md');
  const md = write(dir, 'CLAUDE.md', `keep\n@${missing}`);

  const escaped = missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(globalMemoryPrompt(md), new RegExp(`@${escaped}`));
});

// The text these prompts carry is full of `@anthropic-ai/...` and `@handle`.
// Treating those as imports would at best waste a stat call and at worst read
// something that happens to exist.
test('an at-sign that is not a path is left alone', () => {
  const dir = tmpdir();
  const body = ['install @anthropic-ai/sdk', 'ping @sway about it', 'email a@b.com'].join('\n');
  assert.equal(expandImports(body, dir), body);
});

test('an import inside a longer line is not expanded — only whole lines are imports', () => {
  const dir = tmpdir();
  write(dir, 'x.md', 'SHOULD-NOT-APPEAR');
  const body = `see @${path.join(dir, 'x.md')} for details`;
  assert.equal(expandImports(body, dir), body);
});

// A machine with no global memory must pass no flag at all, not an empty one.
test('a missing ~/.claude/CLAUDE.md reads as empty, not as an error', () => {
  assert.equal(globalMemoryPrompt(path.join(tmpdir(), 'absent.md')), '');
});

test('a global memory of only whitespace reads as empty', () => {
  const dir = tmpdir();
  assert.equal(globalMemoryPrompt(write(dir, 'CLAUDE.md', '\n\n   \n')), '');
});

test('the text handed to a child is capped', () => {
  const dir = tmpdir();
  const md = write(dir, 'CLAUDE.md', 'x'.repeat(MAX_CONTEXT_CHARS + 5_000));
  const out = globalMemoryPrompt(md);
  assert.ok(out.length <= MAX_CONTEXT_CHARS + 40, `got ${out.length}`);
  assert.match(out, /\[global memory truncated\]$/);
});
