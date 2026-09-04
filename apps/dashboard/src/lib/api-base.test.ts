// One installed PWA, several dashboard deployments.
//
// The PWA is bound to ONE origin (the one it was installed from), so an entry
// that lives on another deployment carries that deployment's origin in
// `baseUrl` and every request follows it. The two things worth pinning down:
//
//   1. A keyring written BEFORE this existed has no baseUrl anywhere, and must
//      keep producing byte-identical same-origin URLs — otherwise every
//      single-dashboard user silently starts paying CORS preflights.
//   2. A typo in the backend field must fail loudly at add time, not turn into
//      a relative path that quietly sends a machine key to the wrong server.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// Static imports on purpose: neither module runs anything at module scope, so
// installing the window/storage globals below (before any call) is enough. Top-
// level await isn't available under the repo's tsx/cjs test transform.
import { addMachine } from './keyring';
import { normalizeBase, apiBase, apiUrl, mediaUrl, wsUrl, baseHost, isRemoteBase, adoptMachineFromUrl } from './api-base';
import { withMachine, machineIdFromSearch } from './machine-param';

function mem(): Storage {
  const m = new Map<string, string>();
  const s = {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
  return s as unknown as Storage;
}

const g = globalThis as unknown as Record<string, unknown>;
g.window = { location: { origin: 'https://dash.swaylab.ai', host: 'dash.swaylab.ai', search: '' } };
g.localStorage = mem();
g.sessionStorage = mem();

const HOME = { id: 'm-home', name: 'mac-local', key: 'k-home' };
const AWAY = { id: 'm-away', name: 'zhinan-main', key: 'k-away', baseUrl: 'https://hermit.zhinan.tech' };

beforeEach(() => {
  (g.localStorage as Storage).clear();
  (g.sessionStorage as Storage).clear();
});

// ── normalizeBase ───────────────────────────────────────────────────────────

test('blank backend means this origin', () => {
  assert.equal(normalizeBase(''), '');
  assert.equal(normalizeBase('   '), '');
  assert.equal(normalizeBase(null), '');
  assert.equal(normalizeBase(undefined), '');
});

test('a bare host gets https, and a trailing slash is dropped', () => {
  assert.equal(normalizeBase('hermit.zhinan.tech'), 'https://hermit.zhinan.tech');
  assert.equal(normalizeBase('https://hermit.zhinan.tech/'), 'https://hermit.zhinan.tech');
  assert.equal(normalizeBase('  https://hermit.zhinan.tech  '), 'https://hermit.zhinan.tech');
});

test('a typo is rejected rather than silently becoming a relative path', () => {
  // No scheme + a path is the shape a fat-fingered paste takes.
  assert.throws(() => normalizeBase('hermit.zhinan.tech/chat'), /bare origin/);
  assert.throws(() => normalizeBase('https://hermit.zhinan.tech/api'), /bare origin/);
  assert.throws(() => normalizeBase('https://hermit.zhinan.tech?x=1'), /bare origin/);
  assert.throws(() => normalizeBase('not a url'), /URL/);
});

test('plaintext http is refused except on localhost', () => {
  assert.throws(() => normalizeBase('http://hermit.zhinan.tech'), /https/);
  assert.equal(normalizeBase('http://localhost:4101'), 'http://localhost:4101');
  assert.equal(normalizeBase('http://127.0.0.1:4101'), 'http://127.0.0.1:4101');
});

// A port from the Fetch spec's blocked set is the address that fails WORST: the
// browser refuses to open the connection, and the iOS shell around this same
// function gets an empty document rather than a navigation failure, so it shows
// a white screen with no error and no way back. Refused where it is typed.
//
// The gaps are real, not typos — 104 and 109 are blocked, 105 and 112 are not —
// and are pinned here so that "tidying up the ranges" fails a test instead of
// locking someone out of their own port.
test('a port browsers refuse to open is rejected', () => {
  assert.throws(() => normalizeBase('https://hermit.zhinan.tech:9'), /port 9 is blocked/);
  assert.throws(() => normalizeBase('hermit.zhinan.tech:22'), /port 22 is blocked/);
  assert.throws(() => normalizeBase('http://localhost:6000'), /port 6000 is blocked/);
  assert.throws(() => normalizeBase('https://hermit.zhinan.tech:10080'), /port 10080 is blocked/);
  assert.equal(normalizeBase('https://hermit.zhinan.tech:105'), 'https://hermit.zhinan.tech:105');
  assert.equal(normalizeBase('https://hermit.zhinan.tech:112'), 'https://hermit.zhinan.tech:112');
  assert.equal(normalizeBase('https://hermit.zhinan.tech:8443'), 'https://hermit.zhinan.tech:8443');
});

// ── which backend the active entry names ────────────────────────────────────

test('an old keyring entry (no baseUrl) stays on this origin', () => {
  addMachine(HOME);
  assert.equal(apiBase(), '');
  assert.equal(isRemoteBase(), false);
  assert.equal(apiUrl('/api/trpc'), '/api/trpc');
  assert.equal(mediaUrl('/uploads/s1/a.safe.png'), '/uploads/s1/a.safe.png');
  assert.equal(wsUrl('/api/term/s1'), 'wss://dash.swaylab.ai/api/term/s1');
});

test('an entry naming another deployment sends everything there', () => {
  addMachine(AWAY);
  assert.equal(apiBase(), 'https://hermit.zhinan.tech');
  assert.equal(isRemoteBase(), true);
  assert.equal(apiUrl('/api/trpc'), 'https://hermit.zhinan.tech/api/trpc');
  assert.equal(mediaUrl('/uploads/s1/a.safe.png'), 'https://hermit.zhinan.tech/uploads/s1/a.safe.png');
  assert.equal(wsUrl('/api/term/s1'), 'wss://hermit.zhinan.tech/api/term/s1');
});

test('switching the active entry switches the backend', () => {
  addMachine(HOME);
  addMachine(AWAY); // adding makes it active
  assert.equal(apiBase(), 'https://hermit.zhinan.tech');
  addMachine(HOME);
  assert.equal(apiBase(), '');
});

test('a baseUrl equal to our own origin collapses to same-origin', () => {
  // Otherwise a user who types the address they are already looking at pays a
  // CORS preflight on every request for no reason.
  addMachine({ id: 'm-self', name: 'self', key: 'k', baseUrl: 'https://dash.swaylab.ai' });
  assert.equal(apiBase(), '');
  assert.equal(baseHost('https://dash.swaylab.ai'), '');
});

// ── URL shapes ──────────────────────────────────────────────────────────────

test('only absolute paths are rewritten', () => {
  addMachine(AWAY);
  assert.equal(apiUrl('https://elsewhere.example/x'), 'https://elsewhere.example/x');
  assert.equal(apiUrl('relative/path'), 'relative/path');
  // Attachment URLs that are not uploads are left exactly as they are.
  assert.equal(mediaUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(mediaUrl('blob:https://dash.swaylab.ai/abc'), 'blob:https://dash.swaylab.ai/abc');
  assert.equal(mediaUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
  assert.equal(mediaUrl('/api/file-manager/download/1'), '/api/file-manager/download/1');
});

test('a local backend gets ws, not wss', () => {
  addMachine({ id: 'm-dev', name: 'dev', key: 'k', baseUrl: 'http://127.0.0.1:4101' });
  assert.equal(wsUrl('/api/asr/s1'), 'ws://127.0.0.1:4101/api/asr/s1');
});

test('baseHost labels a row with the deployment it lives on', () => {
  assert.equal(baseHost('https://hermit.zhinan.tech'), 'hermit.zhinan.tech');
  assert.equal(baseHost(null), '');
  assert.equal(baseHost('nonsense'), '');
});

test('no keyring at all behaves as same-origin', () => {
  assert.equal(apiBase(), '');
  assert.equal(apiUrl('/api/trpc'), '/api/trpc');
});

// ── notification tap-through picks the workspace ────────────────────────────

test('a push path carries the machine it came from', () => {
  assert.equal(withMachine('/chat?session=s1', 'm-away'), '/chat?session=s1&m=m-away');
  assert.equal(withMachine('/system', 'm-away'), '/system?m=m-away');
  assert.equal(withMachine('/system', null), '/system');
  assert.equal(machineIdFromSearch('?session=s1&m=m-away'), 'm-away');
  assert.equal(machineIdFromSearch('?session=s1'), null);
  assert.equal(machineIdFromSearch(''), null);
});

function openedAt(search: string) {
  (g.window as { location: { origin: string; host: string; search?: string } }).location.search = search;
}

test('tapping a notification from the other dashboard switches to it', () => {
  addMachine(AWAY);
  addMachine(HOME); // HOME is active
  openedAt('?session=s1&m=m-away');
  adoptMachineFromUrl();
  assert.equal(apiBase(), 'https://hermit.zhinan.tech');
});

test('a tap-through for a machine this browser lost is ignored, not broken', () => {
  addMachine(HOME);
  openedAt('?session=s1&m=m-gone');
  adoptMachineFromUrl();
  assert.equal(apiBase(), '');
  openedAt('');
});
