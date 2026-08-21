import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendUserFileCalls,
  deliveryExternalId,
  blocksFor,
  deliverSendUserFile,
  noteOutboundSync,
  SEND_USER_FILE_TOOL,
  type SendUserFileCall,
  type SendUserFileDeps,
  type UploadedFile,
} from './send-user-file';
import type { SyncItem } from './runtime/types';

// The real thing, copied out of the 2026-08-21 ceo transcript that started this.
const REAL_CALL = {
  type: 'tool_use',
  id: 'toolu_012Lu7V6NcU5e7kdCybDfaFL',
  name: 'SendUserFile',
  input: {
    files: ['/Users/sway003/ceo/projects/oppo-h5-bid/deck.pptx', '/Users/sway003/ceo/projects/oppo-h5-bid/deck.pdf'],
    caption: '技术标应答 41 页',
    status: 'normal',
  },
};

const upload = (over: Partial<UploadedFile> = {}): UploadedFile => ({
  url: '/uploads/s1/abc.pptx', mimeType: 'application/octet-stream', kind: 'file',
  name: 'deck.pptx', width: null, height: null, ...over,
});

function stubDeps(over: Partial<SendUserFileDeps> = {}) {
  const posted: SyncItem[][] = [];
  const marked: string[] = [];
  const uploaded: string[] = [];
  const sent = new Set<string>();
  const deps: SendUserFileDeps = {
    async upload(p) { uploaded.push(p); return upload({ name: p.split('/').pop()! }); },
    async post(items) { posted.push(items); return null; },
    alreadySent: (id) => sent.has(id),
    markSent: (id) => { marked.push(id); sent.add(id); },
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { deps, posted, marked, uploaded, sent };
}

// ── reading the call ─────────────────────────────────────────────────────────

test('sendUserFileCalls: pulls the real transcript call out of a mixed message', () => {
  const calls = sendUserFileCalls([
    { type: 'thinking', thinking: '…' },
    { type: 'text', text: '做完了' },
    REAL_CALL,
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolUseId, 'toolu_012Lu7V6NcU5e7kdCybDfaFL');
  assert.equal(calls[0].files.length, 2);
  assert.equal(calls[0].caption, '技术标应答 41 页');
  assert.equal(calls[0].display, null);
});

test('sendUserFileCalls: accepts the bare-string form the tool schema also allows', () => {
  const calls = sendUserFileCalls([{ type: 'tool_use', id: 't1', name: SEND_USER_FILE_TOOL, input: { files: '/a/b.pdf' } }]);
  assert.deepEqual(calls[0].files, ['/a/b.pdf']);
});

test('sendUserFileCalls: ignores every other tool, including hermit\'s own', () => {
  const calls = sendUserFileCalls([
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', id: 't2', name: 'mcp__hermit__attach_file', input: { filePath: '/a/b.pdf' } },
  ]);
  assert.deepEqual(calls, []);
});

// A call we cannot key is worse than no call: the id IS the dedup key, so posting
// it anyway would add a fresh row on every gateway restart replay.
test('sendUserFileCalls: drops a call with no id and one with no files', () => {
  const calls = sendUserFileCalls([
    { type: 'tool_use', name: SEND_USER_FILE_TOOL, input: { files: ['/a/b.pdf'] } },
    { type: 'tool_use', id: 't2', name: SEND_USER_FILE_TOOL, input: { files: [] } },
    { type: 'tool_use', id: 't3', name: SEND_USER_FILE_TOOL, input: {} },
  ]);
  assert.deepEqual(calls, []);
});

test('sendUserFileCalls: survives junk content', () => {
  assert.deepEqual(sendUserFileCalls(null), []);
  assert.deepEqual(sendUserFileCalls('a string'), []);
  assert.deepEqual(sendUserFileCalls([null, 42, { type: 'tool_use' }]), []);
});

test('deliveryExternalId: derived from the tool_use id so a replay upserts', () => {
  assert.equal(deliveryExternalId('toolu_abc'), 'sent-file-toolu_abc');
});

// ── the blocks that become the row ───────────────────────────────────────────

const call = (over: Partial<SendUserFileCall> = {}): SendUserFileCall =>
  ({ toolUseId: 't1', files: ['/a/deck.pptx'], caption: '', display: null, ...over });

test('blocksFor: a caption leads, then one file block per upload', () => {
  const blocks = blocksFor(call({ caption: '给你' }), [
    { ok: true, path: '/a/deck.pptx', upload: upload() },
  ]) as any[];
  assert.deepEqual(blocks[0], { type: 'text', text: '给你' });
  assert.equal(blocks[1].type, 'file');
  assert.equal(blocks[1].name, 'deck.pptx');
  assert.equal(blocks[1].source.url, '/uploads/s1/abc.pptx');
});

test('blocksFor: an image renders inline, with its dimensions', () => {
  const blocks = blocksFor(call(), [
    { ok: true, path: '/a/shot.png', upload: upload({ kind: 'image', mimeType: 'image/png', width: 800, height: 600 }) },
  ]) as any[];
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].width, 800);
});

test("blocksFor: display:'attach' forces a download card even for an image", () => {
  const blocks = blocksFor(call({ display: 'attach' }), [
    { ok: true, path: '/a/shot.png', upload: upload({ kind: 'image', mimeType: 'image/png', width: 800, height: 600 }) },
  ]) as any[];
  assert.equal(blocks[0].type, 'file');
});

// Silence is the bug this module exists to fix — a file that could not be
// uploaded still has to say so, and say where it is.
test('blocksFor: a failed file becomes a visible note naming the path and reason', () => {
  const blocks = blocksFor(call({ files: ['/a/x.exe'] }), [
    { ok: false, path: '/a/x.exe', reason: '这种文件类型不允许上传（exe）' },
  ]) as any[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /\/a\/x\.exe/);
  assert.match(blocks[0].text, /exe/);
});

test('blocksFor: a partial failure keeps the good file AND reports the bad one', () => {
  const blocks = blocksFor(call({ files: ['/a/deck.pptx', '/a/x.exe'] }), [
    { ok: true, path: '/a/deck.pptx', upload: upload() },
    { ok: false, path: '/a/x.exe', reason: 'nope' },
  ]) as any[];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'file');
  assert.equal(blocks[1].type, 'text');
});

// ── delivery ─────────────────────────────────────────────────────────────────

test('deliverSendUserFile: uploads every file and posts one row keyed on the tool id', async () => {
  const { deps, posted, uploaded, marked } = stubDeps();
  const wrote = await deliverSendUserFile('sess1', call({ files: ['/a/one.pdf', '/a/two.pdf'], caption: 'hi' }), deps);

  assert.equal(wrote, true);
  assert.deepEqual(uploaded, ['/a/one.pdf', '/a/two.pdf']);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].length, 1);
  assert.equal(posted[0][0].sessionId, 'sess1');
  assert.equal(posted[0][0].role, 'assistant');
  assert.equal(posted[0][0].externalId, 'sent-file-t1');
  assert.equal(posted[0][0].claudeSessionId, null);
  assert.equal((posted[0][0].content as unknown[]).length, 3); // caption + 2 files
  assert.deepEqual(marked, ['t1']);
});

// The transcript is replayed from line 1 on every gateway restart. Without the
// marker that is a 14 MB re-upload per restart, per session, forever.
test('deliverSendUserFile: a marked call never uploads again', async () => {
  const { deps, posted, uploaded } = stubDeps();
  await deliverSendUserFile('sess1', call(), deps);
  await deliverSendUserFile('sess1', call(), deps);
  assert.equal(uploaded.length, 1);
  assert.equal(posted.length, 1);
});

// A wholesale failure (dashboard down) is worth retrying; the stable externalId
// means the retry rewrites its own row instead of adding one.
test('deliverSendUserFile: a call where nothing uploaded is NOT marked, so it retries', async () => {
  const { deps, posted, marked } = stubDeps({
    async upload() { throw new Error('ECONNREFUSED'); },
  });
  const wrote = await deliverSendUserFile('sess1', call(), deps);
  assert.equal(wrote, true);          // the failure note still reaches the user
  assert.deepEqual(marked, []);       // but the call stays open for a retry
  assert.match((posted[0][0].content as any[])[0].text, /ECONNREFUSED/);
});

test('deliverSendUserFile: one bad file does not sink the good ones', async () => {
  const { deps, posted, marked } = stubDeps({
    async upload(p) {
      if (p.endsWith('.exe')) throw new Error('415');
      return upload({ name: p.split('/').pop()! });
    },
  });
  await deliverSendUserFile('sess1', call({ files: ['/a/deck.pptx', '/a/x.exe'] }), deps);
  const blocks = posted[0][0].content as any[];
  assert.equal(blocks[0].type, 'file');
  assert.equal(blocks[1].type, 'text');
  assert.deepEqual(marked, ['t1']);   // something landed → don't re-upload it
});

test('deliverSendUserFile: a missing file reads as a missing file, not a stack trace', async () => {
  const { deps, posted } = stubDeps({
    async upload() { throw new Error("ENOENT: no such file or directory, stat '/a/gone.pdf'"); },
  });
  await deliverSendUserFile('sess1', call({ files: ['/a/gone.pdf'] }), deps);
  assert.match((posted[0][0].content as any[])[0].text, /文件已不在磁盘上/);
});

// ── the hook ─────────────────────────────────────────────────────────────────

const item = (over: Partial<SyncItem> = {}): SyncItem =>
  ({ sessionId: 'sess1', role: 'assistant', content: [REAL_CALL], externalId: 'u1', claudeSessionId: null, ...over });

test('noteOutboundSync: fires on an assistant row carrying the call', async () => {
  const { deps, uploaded } = stubDeps();
  noteOutboundSync(item(), deps);
  await new Promise((r) => setImmediate(r));
  assert.equal(uploaded.length, 2);
});

// A streaming preview can hold a half-parsed tool_use; acting on a truncated
// file list would deliver the wrong thing. The finished row always follows.
test('noteOutboundSync: ignores transient previews, retractions and non-assistant rows', async () => {
  const { deps, uploaded } = stubDeps();
  noteOutboundSync(item({ transient: true }), deps);
  noteOutboundSync(item({ deleted: true }), deps);
  noteOutboundSync(item({ role: 'user' }), deps);
  noteOutboundSync(item({ role: 'system' }), deps);
  await new Promise((r) => setImmediate(r));
  assert.equal(uploaded.length, 0);
});

test('noteOutboundSync: a row with no SendUserFile call costs nothing', async () => {
  const { deps, uploaded, posted } = stubDeps();
  noteOutboundSync(item({ content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'x', name: 'Bash', input: {} }] }), deps);
  await new Promise((r) => setImmediate(r));
  assert.equal(uploaded.length, 0);
  assert.equal(posted.length, 0);
});

// The marker only exists once the row is posted; a big file takes seconds to go
// up. Seeing the same call again in that window must not start a second upload.
test('noteOutboundSync: a second sight mid-upload does not start a second upload', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const uploaded: string[] = [];
  const { deps } = stubDeps({
    async upload(p) { uploaded.push(p); await gate; return upload({ name: p.split('/').pop()! }); },
  });

  noteOutboundSync(item(), deps);
  noteOutboundSync(item(), deps);   // same tool_use id, upload still in flight
  await new Promise((r) => setImmediate(r));
  release();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  assert.equal(uploaded.length, 2); // the one call's two files, not four
});

test('noteOutboundSync: never throws when delivery blows up', async () => {
  const { deps } = stubDeps({ async post() { throw new Error('dashboard 502'); } });
  assert.doesNotThrow(() => noteOutboundSync(item(), deps));
  await new Promise((r) => setImmediate(r));
});
