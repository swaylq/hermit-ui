import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_ENTRIES,
  forgetPiSession,
  readPiSession,
  rememberPiSession,
  resumablePiSession,
} from './pi-sessions';

// Every test gets its own store file and its own stand-in session files, so the
// machine's real ~/.hermit/pi-sessions.json is never touched.
function tmp(): { store: string; sessionFile: (name?: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
  return {
    store: path.join(dir, 'nested', 'pi-sessions.json'),
    sessionFile: (name = 'session.jsonl') => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, '{"type":"session_header"}\n');
      return p;
    },
  };
}

test('a session with no pointer reads as null, not as an error', () => {
  const { store } = tmp();
  assert.equal(readPiSession('never-seen', store), null);
  assert.equal(resumablePiSession('never-seen', store), null);
});

test('a remembered pi session is handed back to the next spawn', () => {
  const { store, sessionFile } = tmp();
  const file = sessionFile();

  rememberPiSession('sess-1', { file, piSessionId: '019fd520', cwd: '/agent' }, store);

  const got = resumablePiSession('sess-1', store);
  assert.equal(got?.file, file);
  assert.equal(got?.piSessionId, '019fd520');
  assert.equal(got?.cwd, '/agent');
  assert.ok(got?.updatedAt, 'updatedAt is what the LRU cap sorts on');
});

// The bug this guards: pi reports its session file from getState() as soon as
// the child is up, which can be BEFORE it has written anything to disk. An
// existence check on the way in would discard that pointer every single time,
// and resume would never once work.
test('a pointer is stored even when pi has not written the file yet', () => {
  const { store } = tmp();
  const notYet = path.join(path.dirname(store), 'not-written-yet.jsonl');

  rememberPiSession('sess-1', { file: notYet, piSessionId: 'p1', cwd: '/agent' }, store);

  assert.equal(readPiSession('sess-1', store)?.file, notYet);
  // ...but it is not offered as resumable until it actually exists.
  assert.equal(resumablePiSession('sess-1', store), null);
  fs.writeFileSync(notYet, '{}\n');
  assert.equal(resumablePiSession('sess-1', store)?.file, notYet);
});

// The two nulls mean different things to the caller: "new session, nothing to
// carry over" says nothing to the user, "had a thread and lost the file" does.
test('a vanished session file is remembered but not resumable', () => {
  const { store, sessionFile } = tmp();
  const file = sessionFile();
  rememberPiSession('sess-1', { file, piSessionId: 'p1', cwd: '/agent' }, store);

  fs.rmSync(file);

  assert.equal(readPiSession('sess-1', store)?.file, file, 'the pointer is still on record');
  assert.equal(resumablePiSession('sess-1', store), null, 'but it cannot be reattached');
});

test('pointers whose files are gone are swept on the next write', () => {
  const { store, sessionFile } = tmp();
  const doomed = sessionFile('doomed.jsonl');
  const kept = sessionFile('kept.jsonl');
  rememberPiSession('sess-doomed', { file: doomed, piSessionId: 'p1', cwd: '/a' }, store);
  rememberPiSession('sess-kept', { file: kept, piSessionId: 'p2', cwd: '/a' }, store);

  fs.rmSync(doomed);
  rememberPiSession('sess-new', { file: kept, piSessionId: 'p3', cwd: '/a' }, store);

  assert.equal(readPiSession('sess-doomed', store), null);
  assert.equal(readPiSession('sess-kept', store)?.piSessionId, 'p2');
  assert.equal(readPiSession('sess-new', store)?.piSessionId, 'p3');
});

test('re-booting a session refreshes its pointer instead of adding one', () => {
  const { store, sessionFile } = tmp();
  const first = sessionFile('first.jsonl');
  const second = sessionFile('second.jsonl');

  rememberPiSession('sess-1', { file: first, piSessionId: 'p1', cwd: '/a' }, store);
  rememberPiSession('sess-1', { file: second, piSessionId: 'p2', cwd: '/a' }, store);

  assert.equal(readPiSession('sess-1', store)?.file, second);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(store, 'utf8'))).length, 1);
});

test('the store is capped, and the newest pointer always survives the cap', () => {
  const { store, sessionFile } = tmp();
  const file = sessionFile();

  for (let i = 0; i < MAX_ENTRIES + 20; i += 1) {
    rememberPiSession(`sess-${i}`, {
      file,
      piSessionId: `p${i}`,
      cwd: '/a',
      // Stamped explicitly: writes inside one test can land in the same
      // millisecond, and the cap sorts on this.
      updatedAt: new Date(1_000_000 + i * 1000).toISOString(),
    }, store);
  }

  const onDisk = JSON.parse(fs.readFileSync(store, 'utf8')) as Record<string, unknown>;
  assert.equal(Object.keys(onDisk).length, MAX_ENTRIES);
  assert.ok(onDisk[`sess-${MAX_ENTRIES + 19}`], 'the most recent session must be kept');
  assert.ok(!onDisk['sess-0'], 'the oldest must be the one evicted');
});

// `flushed` is what separates "a conversation was lost" from "there was never a
// conversation": pi writes the session file only once a turn has completed, so
// a pointer without the flag refers to a child that never answered anything.
test('the flushed flag round-trips, and defaults to absent', () => {
  const { store, sessionFile } = tmp();
  const file = sessionFile();

  rememberPiSession('sess-1', { file, piSessionId: 'p1', cwd: '/a' }, store);
  assert.equal(readPiSession('sess-1', store)?.flushed, undefined);

  rememberPiSession('sess-1', { file, piSessionId: 'p1', cwd: '/a', flushed: true }, store);
  assert.equal(readPiSession('sess-1', store)?.flushed, true);
});

test('forgetting a session drops only that pointer', () => {
  const { store, sessionFile } = tmp();
  const file = sessionFile();
  rememberPiSession('sess-1', { file, piSessionId: 'p1', cwd: '/a' }, store);
  rememberPiSession('sess-2', { file, piSessionId: 'p2', cwd: '/a' }, store);

  forgetPiSession('sess-1', store);

  assert.equal(readPiSession('sess-1', store), null);
  assert.equal(readPiSession('sess-2', store)?.piSessionId, 'p2');
});

// A corrupt store must cost one conversation its context, not every pi spawn on
// the machine — this module is on the path of every single one of them.
test('a corrupt store reads as empty and is repaired by the next write', () => {
  const { store, sessionFile } = tmp();
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, '{ this is not json');

  assert.equal(readPiSession('sess-1', store), null);

  const file = sessionFile();
  rememberPiSession('sess-1', { file, piSessionId: 'p1', cwd: '/a' }, store);
  assert.equal(readPiSession('sess-1', store)?.piSessionId, 'p1');
});

test('the write leaves no temp file behind', () => {
  const { store, sessionFile } = tmp();
  rememberPiSession('sess-1', { file: sessionFile(), piSessionId: 'p1', cwd: '/a' }, store);

  assert.ok(fs.existsSync(store));
  assert.ok(!fs.existsSync(`${store}.tmp`));
});
