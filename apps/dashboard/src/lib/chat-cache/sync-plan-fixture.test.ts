// Keeps `apps/ios/tools/fixtures/sync-plan-cases.json` honest.
//
// That file is the ONLY thing tying the Swift port of `planSync`
// (apps/ios/Hermit/SyncPlan.swift) to this one. `apps/ios/tools/cache-fixture.sh`
// runs the Swift implementation against every case in it; this test asserts the
// table is still what `planSync` produces here. Change the rules on this side
// and the table goes stale, so this goes red — on a machine with no Xcode,
// which is where the change will be made.
//
//     pnpm --filter @hermit-ui/dashboard gen:sync-plan-fixture
import assert from 'node:assert/strict';
import test from 'node:test';

import { FIXTURE_JSON, buildFixture, checkedInFixture, renderFixture } from '../../../scripts/gen-sync-plan-fixture';

test('the checked-in sync-plan fixture is what planSync produces today', () => {
  assert.equal(
    checkedInFixture(),
    renderFixture(),
    `${FIXTURE_JSON} is stale. Run: pnpm --filter @hermit-ui/dashboard gen:sync-plan-fixture`,
  );
});

test('the table still covers the answers a reader would guess wrong', () => {
  const byName = new Map(buildFixture().cases.map((c) => [c.name, c]));

  // Each of these is an observable behaviour that nothing in sync-plan.ts says
  // out loud. Losing the case is losing the only place it is written down.
  const backward = byName.get('watermark moved BACKWARD');
  assert.ok(backward);
  assert.equal(backward.expected.fetch[0].since, 100, 'a backward watermark is not a wipe');

  const dupCache = byName.get('duplicated id in the cache');
  assert.ok(dupCache);
  assert.equal(dupCache.expected.fetch[0].since, 40, 'the LAST cached row wins');

  const drops = byName.get('empty probe drops everything');
  assert.ok(drops);
  assert.deepEqual(drops.expected.drop, ['d', 'a', 'c', 'b'], 'drop follows the cache iteration order');

  const ties = byName.get('ties inside a sorted run keep probe order');
  assert.ok(ties);
  assert.deepEqual(
    ties.expected.fetch.map((f) => f.probe.sessionId),
    ['c', 'a', 'e', 'b', 'd', 'f'],
    'the sort is stable across equal watermarks',
  );
});

// ── the search table ────────────────────────────────────────────────────────
// Same mechanism, second function: `ChatCache.search` on the phone answers with
// a SQLite FTS5 index, `searchCorpus` here answers with a linear scan, and the
// only thing keeping them the same product is that they agree on this table.
//
//     pnpm --filter @hermit-ui/dashboard gen:search-fixture
import * as searchFixture from '../../../scripts/gen-search-fixture';

test('the checked-in search fixture is what searchCorpus produces today', () => {
  assert.equal(
    searchFixture.checkedInFixture(),
    searchFixture.renderFixture(),
    `${searchFixture.FIXTURE_JSON} is stale. Run: pnpm --filter @hermit-ui/dashboard gen:search-fixture`,
  );
});

test('the search table still covers the cases a port gets wrong', () => {
  const cases = new Map(searchFixture.buildFixture().cases.map((c) => [c.name, c]));

  // Under three characters is the one length a trigram index cannot answer, and
  // it fails by returning nothing rather than by complaining.
  const short = cases.get('two-character Chinese query');
  assert.ok(short);
  assert.ok(short.expected.totalMessages > 0, 'the two-character case has to actually match something');

  // Matches do not overlap: the walk resumes after the needle.
  const overlap = cases.get('overlapping candidates');
  assert.ok(overlap);
  assert.equal(overlap.expected.hits[0].matchCount, 2, '"aa" in "aaaa" is two matches');

  // Snippet offsets are UTF-16 code units, which is what makes the emoji case
  // worth carrying: three emoji are six units and three Characters.
  const emoji = cases.get('emoji before the match');
  assert.ok(emoji);
  assert.ok(emoji.expected.hits[0].ranges.length > 0, 'the emoji case lost its highlight');
});
