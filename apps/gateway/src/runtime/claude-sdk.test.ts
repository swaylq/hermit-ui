import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodedProjectDir } from '@hermit-ui/tmux-driver';
import { buildUserContent, resumableUuid, shouldBackgroundBash, ClaudeSdkRuntime } from './claude-sdk';

// A 1x1 PNG, so the base64 path is exercised on real bytes rather than a stub.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-sdk-test-'));
}

// ── the user turn's content blocks ──────────────────────────────────────────

test('a plain message is one text block', () => {
  assert.deepEqual(buildUserContent('hello', []), [{ type: 'text', text: 'hello' }]);
});

test('an empty message with no attachments produces no blocks at all', () => {
  // submit() refuses on an empty array rather than sending a contentless turn.
  assert.deepEqual(buildUserContent('   ', []), []);
});

// The pane could not do this: `send-keys` carries no binary, so an uploaded
// screenshot could only be NAMED and the model had to spend a Read tool call on
// it before seeing anything. Here the bytes are in the first request.
test('an image is inlined as a base64 block', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'shot.png');
  fs.writeFileSync(p, PNG_1PX);

  const out = buildUserContent('what is this', [{ path: p, mediaType: 'image/png' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'image');
  assert.equal(out[0].source.type, 'base64');
  assert.equal(out[0].source.media_type, 'image/png');
  assert.equal(out[0].source.data, PNG_1PX.toString('base64'));
  // The text follows the image, so the model sees the picture before the question.
  assert.deepEqual(out[1], { type: 'text', text: 'what is this' });
});

test('the media type is recovered from the extension when the caller omits it', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'shot.jpg');
  fs.writeFileSync(p, PNG_1PX);
  const out = buildUserContent('', [{ path: p, mediaType: '' as any }]);
  assert.equal(out[0].source.media_type, 'image/jpeg');
});

// An over-large image is REJECTED by the Messages API, and a rejected block
// fails the whole turn — so the attachment has to degrade to something that
// always works rather than taking the message down with it.
test('an oversized image falls back to a Read line instead of failing the turn', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'huge.png');
  fs.writeFileSync(p, Buffer.alloc(4_000_000, 1));

  const out = buildUserContent('look', [{ path: p, mediaType: 'image/png' }]);
  assert.equal(out.length, 1, 'no image block');
  assert.equal(out[0].type, 'text');
  assert.match(out[0].text, /^look\n\nRead .*huge\.png$/);
});

test('an unreadable attachment degrades to a Read line rather than vanishing', () => {
  const out = buildUserContent('look', [{ path: '/definitely/not/here.png', mediaType: 'image/png' }]);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /Read \/definitely\/not\/here\.png/);
});

test('a non-image media type is never inlined', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'notes.pdf');
  fs.writeFileSync(p, PNG_1PX);
  const out = buildUserContent('', [{ path: p, mediaType: 'application/pdf' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  assert.match(out[0].text, /Read .*notes\.pdf/);
});

test('several images all ride along, in order', () => {
  const dir = tmpdir();
  const paths = ['a.png', 'b.png'].map((n) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, PNG_1PX);
    return p;
  });
  const out = buildUserContent('compare', paths.map((p) => ({ path: p, mediaType: 'image/png' })));
  assert.equal(out.filter((b) => b.type === 'image').length, 2);
  assert.equal(out[out.length - 1].type, 'text');
});

test('an image with no accompanying text still sends the image', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'only.png');
  fs.writeFileSync(p, PNG_1PX);
  const out = buildUserContent('', [{ path: p, mediaType: 'image/png' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'image');
});

// ── which conversation gets resumed ─────────────────────────────────────────
//
// `claudeSessionId` is ONE column shared by every backend. Getting this wrong in
// the permissive direction hands claude another vendor's id; getting it wrong in
// the strict direction silently starts the user a new conversation. Both are
// bugs this fleet has actually shipped, on other backends.

test('a recorded uuid with a transcript on disk is resumed', () => {
  const cwd = tmpdir();
  const uuid = randomUUID();
  const proj = encodedProjectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${uuid}.jsonl`), '{"type":"user"}\n');

  assert.equal(resumableUuid(cwd, uuid), uuid);
});

test('nothing recorded means a fresh session', () => {
  const cwd = tmpdir();
  assert.equal(resumableUuid(cwd, null), null);
  assert.equal(resumableUuid(cwd, ''), null);
  assert.equal(resumableUuid(cwd, '   '), null);
});

// A session switched here from codex arrives holding a codex thread id, and from
// pi a pi session id. Handing either to `--resume` is at best meaningless.
test("another backend's session id is not mistaken for a transcript", () => {
  const cwd = tmpdir();
  assert.equal(resumableUuid(cwd, 'thread_abc123'), null);
  assert.equal(resumableUuid(cwd, 'pi-sess-9'), null);
});

// Claude Code prunes transcripts on cleanupPeriodDays (30 by default), so a
// long-idle session's history simply ages off disk. Resuming it errors "No
// conversation found" and exits instantly — which, on the pane path, meant the
// wake retried forever and the queued message never landed. Starting fresh is
// the recovery.
test('a recorded uuid whose transcript was pruned starts fresh instead of failing forever', () => {
  const cwd = tmpdir();
  assert.equal(resumableUuid(cwd, randomUUID()), null);
});

test('an empty transcript file is not a conversation', () => {
  const cwd = tmpdir();
  const uuid = randomUUID();
  const proj = encodedProjectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${uuid}.jsonl`), '');

  assert.equal(resumableUuid(cwd, uuid), null);
});

test('the uuid check is case-insensitive but shape-strict', () => {
  const cwd = tmpdir();
  const uuid = randomUUID().toUpperCase();
  const proj = encodedProjectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${uuid}.jsonl`), 'x\n');

  assert.equal(resumableUuid(cwd, uuid), uuid);
  assert.equal(resumableUuid(cwd, uuid.slice(0, -1)), null);
  assert.equal(resumableUuid(cwd, `${uuid}-extra`), null);
});

// ── which Bash calls start in the background ────────────────────────────────
//
// A PreToolUse hook, not `canUseTool`: under `bypassPermissions` — which every
// dashboard session runs — the SDK never consults canUseTool and says so
// outright ("permissionMode 'bypassPermissions' auto-approves every tool call
// before the callback is consulted"). Hooks fire regardless of permission mode.

test('commands whose whole job is to take minutes start backgrounded', () => {
  for (const cmd of [
    'npm install', 'npm ci', 'npm i --save-dev x', 'pnpm install', 'yarn install',
    'docker build -t x .', 'docker compose up -d', 'make -j8', 'cargo build --release',
    'gradle assemble', 'mvn package', 'pytest -q', 'go test ./...', 'terraform apply',
  ]) {
    assert.equal(shouldBackgroundBash({ command: cmd }), true, cmd);
  }
});

test('ordinary commands are left exactly as the model wrote them', () => {
  for (const cmd of ['ls -la', 'git status', 'echo hi', 'cat package.json', 'npm run lint', 'rg foo']) {
    assert.equal(shouldBackgroundBash({ command: cmd }), false, cmd);
  }
});

// The model stating either is a decision about its own command; overriding it
// would be the harness second-guessing the agent.
test('a model that already chose how to run it is not overridden', () => {
  assert.equal(shouldBackgroundBash({ command: 'npm ci', run_in_background: true }), false);
  assert.equal(shouldBackgroundBash({ command: 'npm ci', timeout: 30_000 }), false);
  // …but a command that said neither is still eligible.
  assert.equal(shouldBackgroundBash({ command: 'npm ci' }), true);
});

test('a malformed tool input is never acted on', () => {
  for (const bad of [null, undefined, 'npm ci', 42, [], {}, { command: '' }, { command: 7 }]) {
    assert.equal(shouldBackgroundBash(bad), false, JSON.stringify(bad));
  }
});

// ── storedUsage: read the path you were given, do not go looking ────────────
// The snapshot collector calls this for every non-alive session on an 8-second
// tick. Without a path it has to FIND the transcript, which is a readdir of the
// agent root plus up to one open per agent (48 on this machine) — for a number
// the collector's own transcript tail had almost always already supplied. The
// path argument is the fix; these pin that it is actually honoured.

function writeTranscript(dir: string, name: string, events: unknown[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

const assistantUsage = (input: number, cacheRead: number, output: number) => ({
  type: 'assistant',
  message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: output } },
});

test('storedUsage reads the transcript it is handed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-usage-'));
  const uuid = randomUUID();
  const p = writeTranscript(dir, `${uuid}.jsonl`, [
    assistantUsage(10, 20, 5),
    assistantUsage(1_000, 24_000, 700),   // newest wins
  ]);
  const rt = new ClaudeSdkRuntime();
  const u = await rt.storedUsage({ sessionId: 'sess-stored-1', externalSessionId: uuid }, p);
  assert.equal(u?.contextTokens, 25_000);
  assert.equal(u?.outputTokens, 700);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The uuid gate exists only to BUILD a filename for the search. A caller that
// hands over the file has already answered the question the gate asks, so the
// path must be honoured ahead of it — otherwise the fast path silently falls
// through to the slow one for exactly the sessions that pass a path.
test('a handed path is honoured before the uuid gate the search needs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-usage-'));
  const p = writeTranscript(dir, 'not-a-uuid.jsonl', [assistantUsage(500, 0, 12)]);
  const rt = new ClaudeSdkRuntime();
  const u = await rt.storedUsage({ sessionId: 'sess-stored-2', externalSessionId: 'not-a-uuid' }, p);
  assert.equal(u?.contextTokens, 500);
  assert.equal(u?.outputTokens, 12);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a transcript with no usage record, and a path that is not there, both read null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-usage-'));
  const rt = new ClaudeSdkRuntime();
  const empty = writeTranscript(dir, 'empty.jsonl', [{ type: 'user', message: { content: 'hi' } }]);
  assert.equal(await rt.storedUsage({ sessionId: 'sess-stored-3', externalSessionId: 'x' }, empty), null);
  const missing = path.join(dir, 'gone.jsonl');
  assert.equal(await rt.storedUsage({ sessionId: 'sess-stored-4', externalSessionId: 'x' }, missing), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
