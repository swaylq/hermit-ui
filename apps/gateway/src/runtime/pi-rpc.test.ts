import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextTokensFrom, emitItemsFor } from './pi-rpc';

// The bug this guards: ensure() awaited client.start() between checking the
// live map and populating it, so concurrent chatTicks each spawned their own pi
// child and registered their own event listener. Every event was then emitted
// once per listener with an independent ordinal, and the same turn appeared
// three times in the dashboard.
//
// This models the guard itself rather than importing pi-rpc.ts, which would
// spawn real child processes. The invariant under test is "N concurrent
// ensure() calls for one session produce exactly one boot".

function makeEnsure(boot: (id: string) => Promise<{ id: string }>) {
  const live = new Map<string, { id: string }>();
  const starting = new Map<string, Promise<{ id: string }>>();

  return async function ensure(id: string) {
    const existing = live.get(id);
    if (existing) return existing;
    const inFlight = starting.get(id);
    if (inFlight) return inFlight;

    const p = boot(id).then((h) => { live.set(id, h); return h; })
      .finally(() => starting.delete(id));
    starting.set(id, p);
    return p;
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
