// Bark transport: the request we actually put on the wire, and the one judgement
// call in the file — which failure means "this device is gone".
//
// bark-server is stubbed rather than contacted. What matters here is that our
// PushEvent semantics survive the translation: the collapse key has to land in
// `id` (Bark's replace-in-place field) or a busy session stacks up a dozen
// notifications, and urgency has to land in `level` or nothing pierces a Focus mode.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { barkTransport, isDeadKeyResponse, parseBarkTarget, DEFAULT_BARK_SERVER } from './bark';
import type { PushDeviceRow, TransportPayload } from './transport';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** Stub fetch, returning `status`/`text`, and capture what was sent. */
function stubFetch(status = 200, text = '{"code":200,"message":"success"}'): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(text, { status });
  }) as unknown as typeof fetch;
  return calls;
}

const device = (over: Partial<PushDeviceRow> = {}): PushDeviceRow => ({
  id: 'd1',
  platform: 'bark',
  token: 'dQw4w9WgXcQ',
  apnsEnv: 'sandbox',
  subscription: null,
  barkServer: null,
  ...over,
});

const payload = (over: Partial<TransportPayload> = {}): TransportPayload => ({
  title: 'agent-x',
  body: 'finished the migration',
  path: '/chat?session=abc',
  collapseKey: 'abc',
  kind: 'chat',
  urgent: false,
  ...over,
});

test('needs no server-side credential — always configured', () => {
  assert.equal(barkTransport.isConfigured(), true);
});

// ── registration input ──────────────────────────────────────────────────────
// Regression tests for a real failure: registration silently did nothing because
// the field only took a bare key, while the Bark app's copy button gives you the
// whole URL. Nothing was written and the person reasonably believed it had been.

// 22 base57 chars, the shape shortuuid.New() actually produces.
const KEY = 'zGkFvMxQrT7nBpLw3sHdCa';

test('a bare device key is taken as-is, on the default server', () => {
  assert.deepEqual(parseBarkTarget(KEY), { ok: true, deviceKey: KEY, server: null });
});

test('the full URL the Bark app copies is accepted', () => {
  for (const url of [
    `https://api.day.app/${KEY}`,
    `https://api.day.app/${KEY}/`,
    // What the app's home screen literally shows — key first, placeholder body after.
    `https://api.day.app/${KEY}/%E6%8E%A8%E9%80%81%E5%86%85%E5%AE%B9`,
    `https://api.day.app/${KEY}/title/body`,
  ]) {
    assert.deepEqual(parseBarkTarget(url), { ok: true, deviceKey: KEY, server: null }, url);
  }
});

test('the key is the FIRST path segment, never the last', () => {
  // Taking the last would grab the placeholder body text and register a device
  // key that has never existed — which fails only later, at push time.
  const r = parseBarkTarget(`https://api.day.app/${KEY}/some-body-text`);
  assert.equal(r.ok && r.deviceKey, KEY);
});

test('a self-hosted URL carries its own server across', () => {
  assert.deepEqual(parseBarkTarget(`https://bark.example.com/${KEY}/x`), {
    ok: true,
    deviceKey: KEY,
    server: 'https://bark.example.com',
  });
});

test('the public default is stored as null, not spelled out', () => {
  // Writing the default in would become a lie the day the default moves.
  const r = parseBarkTarget(KEY, DEFAULT_BARK_SERVER);
  assert.equal(r.ok && r.server, null);
});

test('an explicitly typed server beats the pasted URL origin', () => {
  const r = parseBarkTarget(`https://api.day.app/${KEY}`, 'https://bark.example.com/');
  assert.equal(r.ok && r.server, 'https://bark.example.com');
});

test('unusable input is rejected with a reason, not a crash', () => {
  assert.deepEqual(parseBarkTarget(''), { ok: false, reason: 'empty' });
  assert.deepEqual(parseBarkTarget('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(parseBarkTarget('short'), { ok: false, reason: 'bad-key' });
  assert.deepEqual(parseBarkTarget('has spaces in it'), { ok: false, reason: 'bad-key' });
  assert.deepEqual(parseBarkTarget('https://api.day.app/'), { ok: false, reason: 'bad-key' });
  // Not http(s) — no reason to let a javascript:/file: URL through the parser.
  assert.deepEqual(parseBarkTarget(`ftp://api.day.app/${KEY}`), { ok: false, reason: 'bad-key' });
  assert.deepEqual(parseBarkTarget(KEY, 'not a url'), { ok: false, reason: 'bad-server' });
});

test('posts to /push on the public server by default', async () => {
  const calls = stubFetch();
  const r = await barkTransport.send(device(), payload());
  assert.deepEqual(r, { ok: true, dead: false });
  assert.equal(calls[0].url, `${DEFAULT_BARK_SERVER}/push`);
  assert.equal(calls[0].body.device_key, 'dQw4w9WgXcQ');
  assert.equal(calls[0].body.title, 'agent-x');
  assert.equal(calls[0].body.body, 'finished the migration');
});

test('a self-hosted server wins, trailing slash and all', async () => {
  const calls = stubFetch();
  await barkTransport.send(device({ barkServer: 'https://bark.example.com/' }), payload());
  assert.equal(calls[0].url, 'https://bark.example.com/push');
});

test('the collapse key becomes Bark `id`, so one session keeps one slot', async () => {
  const calls = stubFetch();
  await barkTransport.send(device(), payload({ collapseKey: 'session-42' }));
  assert.equal(calls[0].body.id, 'session-42');
});

test('urgent kinds ask for timeSensitive, ordinary ones do not', async () => {
  let calls = stubFetch();
  await barkTransport.send(device(), payload({ kind: 'blocked', urgent: true }));
  assert.equal(calls[0].body.level, 'timeSensitive');

  calls = stubFetch();
  await barkTransport.send(device(), payload({ kind: 'chat', urgent: false }));
  assert.equal(calls[0].body.level, 'active');
  // `critical` overrides the mute switch; nothing here earns that.
  assert.notEqual(calls[0].body.level, 'critical');
});

test('the tap-through URL is absolute, built from PUSH_PUBLIC_ORIGIN', async () => {
  const prev = process.env.PUSH_PUBLIC_ORIGIN;
  process.env.PUSH_PUBLIC_ORIGIN = 'https://dash.example.com/';
  try {
    const calls = stubFetch();
    await barkTransport.send(device(), payload({ path: '/chat?session=abc' }));
    assert.equal(calls[0].body.url, 'https://dash.example.com/chat?session=abc');
  } finally {
    if (prev === undefined) delete process.env.PUSH_PUBLIC_ORIGIN;
    else process.env.PUSH_PUBLIC_ORIGIN = prev;
  }
});

test('an unknown device key is reaped; an APNs-side failure is not', async () => {
  stubFetch(400, '{"code":400,"message":"failed to get device token: key not found"}');
  assert.deepEqual((await barkTransport.send(device(), payload())).dead, true);

  // 500 is bark-server failing to reach APNs — transient. Deleting the row here
  // would silently unsubscribe a working phone.
  stubFetch(500, '{"code":500,"message":"push failed: connection reset"}');
  assert.deepEqual((await barkTransport.send(device(), payload())).dead, false);

  // 400 for our own malformed request is not the device's fault either.
  stubFetch(400, '{"code":400,"message":"device key is empty"}');
  assert.deepEqual((await barkTransport.send(device(), payload())).dead, false);
});

test('isDeadKeyResponse matches the message, not the bare status', () => {
  assert.equal(isDeadKeyResponse(400, 'failed to get device token: not found'), true);
  assert.equal(isDeadKeyResponse(400, 'device key is empty'), false);
  assert.equal(isDeadKeyResponse(500, 'failed to get device token'), false);
  assert.equal(isDeadKeyResponse(200, ''), false);
});

test('a network failure is reported, never thrown', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const r = await barkTransport.send(device(), payload());
  assert.equal(r.ok, false);
  assert.equal(r.dead, false, 'a dead network is not a dead device');
  assert.match(String(r.detail), /ECONNREFUSED/);
});
