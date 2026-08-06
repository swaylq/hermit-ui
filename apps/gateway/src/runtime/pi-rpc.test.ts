import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextTokensFrom, emitItemsFor, eventKeyFor, providerMismatch, singleFlight } from './pi-rpc';

// The bug this guards: ensure() awaited client.start() between checking the
// live map and populating it, so concurrent chatTicks each spawned their own pi
// child and registered their own event listener. Every event was then emitted
// once per listener with an independent ordinal, and the same turn appeared
// three times in the dashboard.
//
// The first version of this file re-implemented the guard locally, to avoid
// importing a module that spawns child processes — and so it passed while
// ensure() itself never read the map it was supposed to consult. It now drives
// the real guard (`singleFlight`), with `boot` standing in for the spawn.

function makeEnsure(boot: (id: string) => Promise<{ id: string }>) {
  const live = new Map<string, { id: string }>();
  const starting = new Map<string, Promise<{ id: string }>>();

  return async function ensure(id: string) {
    const existing = live.get(id);
    if (existing) return existing;
    return singleFlight(starting, id, () => boot(id).then((h) => { live.set(id, h); return h; }));
  };
}

test('concurrent ensure() for one session boots exactly once', async () => {
  let boots = 0;
  const ensure = makeEnsure(async (id) => {
    boots += 1;
    await new Promise((r) => setTimeout(r, 30)); // client.start() latency
    return { id };
  });

  const handles = await Promise.all([ensure('s1'), ensure('s1'), ensure('s1'), ensure('s1')]);

  assert.equal(boots, 1, 'only one pi child may be spawned per session');
  for (const h of handles) assert.equal(h.id, 's1');
  assert.equal(new Set(handles).size, 1, 'every caller must get the same handle');
});

test('a settled session is served from the live map without re-booting', async () => {
  let boots = 0;
  const ensure = makeEnsure(async (id) => { boots += 1; return { id }; });

  await ensure('s1');
  await ensure('s1');
  await ensure('s1');

  assert.equal(boots, 1);
});

test('different sessions still boot independently', async () => {
  let boots = 0;
  const ensure = makeEnsure(async (id) => {
    boots += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { id };
  });

  const [a, b] = await Promise.all([ensure('s1'), ensure('s2')]);

  assert.equal(boots, 2);
  assert.notEqual(a, b);
});

test('a failed boot does not poison later attempts', async () => {
  let boots = 0;
  const ensure = makeEnsure(async (id) => {
    boots += 1;
    if (boots === 1) throw new Error('start failed');
    return { id };
  });

  await assert.rejects(ensure('s1'));
  const ok = await ensure('s1');

  assert.equal(ok.id, 's1');
  assert.equal(boots, 2, 'the in-flight entry must be cleared on failure');
});

// externalId is what /api/sync/chat-message upserts on, and a conflict is an
// UPDATE of the existing row's content. pi's events carry no durable id, so the
// key falls back to a counter — which used to restart at 0 in every new child,
// meaning the first turn after a gateway restart rewrote the session's opening
// message in place instead of appending a reply.
test('the same ordinal in two different children yields different ids', () => {
  const first = { bootId: 'sess-abc-boot1', ordinal: 0 };
  const second = { bootId: 'sess-abc-boot2', ordinal: 0 };

  assert.notEqual(eventKeyFor(first, null), eventKeyFor(second, null));
});

test('a durable entry id wins and does not consume an ordinal', () => {
  const h = { bootId: 'b', ordinal: 0 };

  assert.equal(eventKeyFor(h, { entryId: 'entry-9' }), 'entry-9');
  assert.equal(h.ordinal, 0, 'a replayed entry must key on its own id, not on position');
});

test('successive events in one child get successive ordinals', () => {
  const h = { bootId: 'b', ordinal: 0 };

  const keys = [eventKeyFor(h, null), eventKeyFor(h, null), eventKeyFor(h, null)];

  assert.equal(new Set(keys).size, 3);
  assert.equal(h.ordinal, 3);
});

// contextTokens must mean the same thing on both backends. The claude path
// reports the LAST turn's window occupancy (input + cache_creation + cache_read
// off the newest assistant message); a cumulative session total would render as
// a context bar that only ever fills up.
test('last-turn context tokens mirror the claude formula', () => {
  // claude: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  assert.equal(contextTokensFrom({ input: 1200, output: 75, cacheRead: 800, cacheWrite: 200 }), 2200);
});

test('cache is counted, not just input', () => {
  assert.notEqual(contextTokensFrom({ input: 1200, cacheRead: 800, cacheWrite: 200 }), 1200);
});

test('a turn with no cache reports just its input', () => {
  assert.equal(contextTokensFrom({ input: 500, output: 10, cacheRead: 0, cacheWrite: 0 }), 500);
});

test('missing usage is null, not zero — null renders as "no data", 0 as "empty window"', () => {
  assert.equal(contextTokensFrom(null), null);
  assert.equal(contextTokensFrom(undefined), null);
});

test('malformed usage fields degrade to 0 rather than NaN', () => {
  assert.equal(contextTokensFrom({ input: 'x' as unknown as number, cacheRead: 100 }), 100);
  assert.equal(contextTokensFrom({}), 0);
});

// ChatSession.claudeSessionId is Claude Code's --resume handle. Now that a
// session can be moved between backends, a pi turn that stamped its own id
// there would wipe the claude transcript handle — switching back would silently
// start a fresh claude with no history.
test('pi never stamps ChatSession.claudeSessionId', () => {
  const items = emitItemsFor('sess-1', 'sess-1:entry-9', {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].claudeSessionId, null);
  assert.equal(items[0].sessionId, 'sess-1');
  assert.equal(items[0].externalId, 'sess-1:entry-9');
});

test('every item of a multi-block event carries the session, none the resume handle', () => {
  const items = emitItemsFor('sess-2', 'sess-2:e1', {
    type: 'tool_execution_end',
    toolCallId: 'tc1',
    toolName: 'bash',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] },
  });
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.equal(it.sessionId, 'sess-2');
    assert.equal(it.claudeSessionId, null);
  }
});

test('an event that translates to nothing emits nothing', () => {
  assert.deepEqual(emitItemsFor('sess-3', 'sess-3:e1', { type: 'message_start' }), []);
});

// The bug this guards, measured on a live child: `provider: undefined` with the
// machine's default model id made pi resolve `claude-opus-5` against its own
// catalogue and come back on {provider: 'anthropic', baseUrl:
// api.anthropic.com} — which this machine has no key for. The turn then emitted
// nothing at all: no reply, no error event, no stderr. Every pi session that
// pinned no provider stopped answering, silently, and the chat waited forever.
test('pi landing on a provider we did not ask for is a mismatch', () => {
  const m = providerMismatch('hyqubit', {
    model: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  });
  assert.equal(m?.wanted, 'hyqubit');
  assert.equal(m?.got, 'anthropic');
  assert.equal(m?.baseUrl, 'https://api.anthropic.com');
});

test('the provider we asked for is not a mismatch', () => {
  assert.equal(providerMismatch('hyqubit', { model: { provider: 'hyqubit' } }), null);
});

// Silence is not disagreement: an unconfigured machine (no provider to ask for)
// and a pi build that reports no provider must not raise a false alarm on every
// single boot.
test('missing information on either side is not a mismatch', () => {
  assert.equal(providerMismatch(undefined, { model: { provider: 'anthropic' } }), null);
  assert.equal(providerMismatch('hyqubit', { model: {} }), null);
  assert.equal(providerMismatch('hyqubit', null), null);
});
