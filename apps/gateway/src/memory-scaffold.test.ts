import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_INDEX_SEED, seedMemoryStore } from './memory-scaffold';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memseed-'));
}

test('a fresh agent gets memory/notes/ and a seeded index', () => {
  const d = tmpdir();
  seedMemoryStore(d);
  assert.ok(fs.statSync(path.join(d, 'memory', 'notes')).isDirectory());
  assert.equal(fs.readFileSync(path.join(d, 'memory', 'notes', 'INDEX.md'), 'utf8'), MEMORY_INDEX_SEED);
});

test('an existing index is never clobbered', () => {
  const d = tmpdir();
  const index = path.join(d, 'memory', 'notes', 'INDEX.md');
  fs.mkdirSync(path.dirname(index), { recursive: true });
  fs.writeFileSync(index, '- [Real Note](real.md) — hard-won\n');
  seedMemoryStore(d);
  assert.match(fs.readFileSync(index, 'utf8'), /hard-won/);
});

test('running it twice is a no-op, not an error', () => {
  const d = tmpdir();
  seedMemoryStore(d);
  seedMemoryStore(d);
  assert.equal(fs.readdirSync(path.join(d, 'memory', 'notes')).length, 1);
});

test('the seed points at the index the docs send agents to, and says nothing writes it', () => {
  // AGENTS.md / CLAUDE.md both route "search before you answer" here; if this
  // wording drifts from the path in the docs, the rule points at nothing.
  assert.match(MEMORY_INDEX_SEED, /memory\/notes\//);
  assert.match(MEMORY_INDEX_SEED, /CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/);
  assert.match(MEMORY_INDEX_SEED, /Nothing writes this for you/);
});
