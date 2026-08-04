import { test } from 'node:test';
import assert from 'node:assert/strict';

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
