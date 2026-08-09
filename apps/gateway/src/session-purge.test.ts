// What the purge is allowed to delete off disk.
//
// ~/.claude/projects is shared ground: it holds every claude run on the host,
// and the human's own terminal sessions live in the same per-directory folders
// as the agents' (they are run in the agent directories). Nothing about a file
// says who wrote it. The only thing that makes a delete safe is the session row
// we are purging naming the file — so these tests are about refusing, and the
// one accept case is the narrow shape where that proof exists.
//
// The failure this prevents is not a crash. It is silently deleting the user's
// own conversation history during a routine cleanup.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts exits without a key; nothing here talks to the dashboard.
process.env.ASST_KEY ||= 'test-key-unused';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-purge-'));
process.env.PROJECTS_ROOT = root;
const { deleteTranscript } = await import('./session-purge');

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let projectDir: string;
let outside: string;

before(() => {
  projectDir = path.join(root, '-Users-test-agent');
  fs.mkdirSync(projectDir, { recursive: true });
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-notours-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function makeTranscript(dir: string, uuid: string): string {
  const p = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(p, '{}\n');
  return p;
}

test('deletes the transcript the purged row names', () => {
  const p = makeTranscript(projectDir, UUID);
  assert.equal(deleteTranscript(p, UUID), true);
  assert.equal(fs.existsSync(p), false);
});

test('refuses when the filename is not the uuid the row recorded', () => {
  // The sibling transcript in the same project dir belongs to another session —
  // possibly one running right now.
  const sibling = makeTranscript(projectDir, OTHER);
  assert.equal(deleteTranscript(sibling, UUID), false);
  assert.equal(fs.existsSync(sibling), true);
});

test('refuses a path outside the projects root', () => {
  const stray = makeTranscript(outside, UUID);
  assert.equal(deleteTranscript(stray, UUID), false);
  assert.equal(fs.existsSync(stray), true);
});

test('refuses a path that escapes the root via ..', () => {
  const stray = makeTranscript(outside, UUID);
  const traversal = path.join(root, '..', path.basename(outside), `${UUID}.jsonl`);
  assert.equal(deleteTranscript(traversal, UUID), false);
  assert.equal(fs.existsSync(stray), true);
});

test('refuses when either half of the proof is missing', () => {
  const p = makeTranscript(projectDir, UUID);
  assert.equal(deleteTranscript(null, UUID), false);
  assert.equal(deleteTranscript(p, null), false);
  assert.equal(fs.existsSync(p), true);
});

test('an already-deleted transcript is not an error', () => {
  // Purge must stay idempotent: a retried tick after a partial failure has to be
  // able to finish the row rather than wedge on a missing file.
  const p = path.join(projectDir, `${OTHER}.jsonl`);
  fs.rmSync(p, { force: true });
  assert.equal(deleteTranscript(p, OTHER), false);
});
