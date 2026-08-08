// Bark transport: the request we actually put on the wire, and the one judgement
// call in the file — which failure means "this device is gone".
//
// bark-server is stubbed rather than contacted. What matters here is that our
// PushEvent semantics survive the translation: the collapse key has to land in
// `id` (Bark's replace-in-place field) or a busy session stacks up a dozen
// notifications, and urgency has to land in `level` or nothing pierces a Focus mode.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { barkTransport, isDeadKeyResponse, DEFAULT_BARK_SERVER } from './bark';
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
