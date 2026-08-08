// "Continue where I left off": reopening the dashboard must land back in the chat
// you had open, on the machine you had open. The machine half is keyring.ts (its
// active id mirrors to localStorage, which a freshly-opened tab inherits); this
// covers the session half and the seam between them — a session id is only ever
// valid for the machine it was remembered on.
//
// A fresh browser tab = the same localStorage with an EMPTY sessionStorage, which
// is what `reopenTab()` below simulates.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { addMachine, addScopedMachine, removeMachine, setActiveMachine } from './keyring';
import { rememberSession, lastSessionId } from './last-session';

// Storage/window globals must exist before keyring.ts touches them. Nothing runs
// at module scope in either module, so installing them here (before any call) is
// enough — but do it before the imports are USED, not merely before they're read.
function mem(): Storage {
  const m = new Map<string, string>();
  let failWrites = false;
  const s = {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error('QuotaExceededError'); // private mode
      m.set(k, String(v));
    },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    fail: (on: boolean) => { failWrites = on; },
  };
  return s as unknown as Storage;
}

const g = globalThis as unknown as Record<string, unknown>;
g.window = {};
g.localStorage = mem();
g.sessionStorage = mem();

const A = { id: 'mach-a', name: 'macmini001', key: 'k-a' };
const B = { id: 'mach-b', name: 'macmini002', key: 'k-b' };

// Closing the browser and opening it again: localStorage survives, sessionStorage
// (the per-tab active-machine pick) does not.
function reopenTab() {
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
}

beforeEach(() => {
  (g.localStorage as Storage).clear();
  (g.sessionStorage as Storage).clear();
});

test('a reopened tab resumes the chat that was open, not whatever is newest', () => {
  addMachine(A);
  rememberSession('sess-1');
  reopenTab();
  assert.equal(lastSessionId(), 'sess-1');
});

test('the memory follows the machine — each keeps its own chat', () => {
  addMachine(A);
  rememberSession('sess-a');
  addMachine(B); // adding makes B active
  rememberSession('sess-b');

  reopenTab();
  assert.equal(lastSessionId(), 'sess-b', 'reopens on the last machine picked');
  setActiveMachine(A.id);
  assert.equal(lastSessionId(), 'sess-a', 'switching back restores A’s chat, not B’s');
  setActiveMachine(B.id);
  assert.equal(lastSessionId(), 'sess-b');
});

test('an agent-share tab cannot overwrite the machine’s remembered chat', () => {
  addMachine(A);
  rememberSession('sess-a');
  // A share link makes its own entry active for THIS tab only (keyring.ts), so
  // the chat it opens is filed under the share id.
  addScopedMachine({ id: 'shr-1', name: 'shared', key: 'shr_x', scoped: true, agentName: 'scribe' });
  rememberSession('sess-shared');
  assert.equal(lastSessionId(), 'sess-shared');

  setActiveMachine(A.id);
  assert.equal(lastSessionId(), 'sess-a');
});

test('a machine dropped from the keyring drops its remembered chat', () => {
  addMachine(A);
  rememberSession('sess-a');
  addMachine(B);
  rememberSession('sess-b');

  removeMachine(A.id);
  rememberSession('sess-b2'); // the next write is what prunes
  assert.match(
    (g.localStorage as Storage).getItem('hermit:last-session') ?? '',
    /^\{"mach-b":"sess-b2"\}$/,
    'no leftover slot for a machine the user removed',
  );
});

test('no machine, no memory — and remembering is a harmless no-op', () => {
  assert.equal(lastSessionId(), null);
  assert.doesNotThrow(() => rememberSession('sess-1'));
  assert.equal((g.localStorage as Storage).getItem('hermit:last-session'), null);
});

test('a blank session id is never remembered', () => {
  addMachine(A);
  rememberSession('sess-a');
  rememberSession('');
  assert.equal(lastSessionId(), 'sess-a');
});

test('corrupt storage reads as "no memory" instead of throwing', () => {
  addMachine(A);
  for (const junk of ['not json', '[]', '"str"', 'null', '{"mach-a":42}', '{"mach-a":""}']) {
    (g.localStorage as Storage).setItem('hermit:last-session', junk);
    assert.equal(lastSessionId(), null, junk);
  }
});

test('a storage that refuses writes (private mode) does not break the caller', () => {
  addMachine(A);
  const store = g.localStorage as Storage & { fail: (on: boolean) => void };
  store.fail(true);
  assert.doesNotThrow(() => rememberSession('sess-a'));
  store.fail(false);
  assert.equal(lastSessionId(), null, 'nothing stored, so landing falls back as before');
});
