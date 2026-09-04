/**
 * Renders `apps/ios/tools/fixtures/sync-plan-cases.json` — one table of inputs
 * and the outputs THIS `planSync` produces for them, today.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:sync-plan-fixture
 *
 * Why a generated table instead of two hand-written test suites: `planSync` is
 * being reimplemented in Swift (apps/ios/Hermit/SyncPlan.swift), and the way a
 * port goes wrong is never the case the author thought about. It is the ones
 * they inferred by reading — and several of this function's answers are decided
 * by JavaScript rather than by anything written down here:
 *
 *   · `drop` comes out in the order `cached` was iterated, because it walks a
 *     Map built from it. A Swift Dictionary has no order at all.
 *   · fetches with EQUAL watermarks keep their probe order, because
 *     Array.prototype.sort has been stable since ES2019. Swift's `sort` is
 *     explicitly not.
 *   · a duplicated id survives in `fetch` but collapses in the Map.
 *
 * None of that is in the doc comment, and all of it is observable. So the
 * fixture is produced by RUNNING the real function, and `sync-plan-fixture.test.ts`
 * fails the moment the checked-in table stops being what it produces.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { planSync, type ProbeRow, type SyncPlan } from '../src/lib/chat-cache/sync-plan';
import type { CachedSession } from '../src/lib/chat-cache/types';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURE_JSON = 'apps/ios/tools/fixtures/sync-plan-cases.json';

type Case = {
  name: string;
  /** Why this case is in the table — read by whoever is debugging a red one. */
  why: string;
  probe: ProbeRow[];
  cached: CachedSession[];
  expected: SyncPlan;
};

/** Terse builders: the table is read as data, so the noise is not worth it. */
const p = (sessionId: string, watermark: number, count: number, extra: Partial<ProbeRow> = {}): ProbeRow => ({
  sessionId,
  agentName: 'asst',
  title: null,
  preview: null,
  watermark,
  count,
  ...extra,
});
const c = (sessionId: string, watermark: number, count: number, extra: Partial<CachedSession> = {}): CachedSession => ({
  sessionId,
  agentName: 'asst',
  title: null,
  preview: null,
  watermark,
  count,
  ...extra,
});

const INPUTS: Array<Omit<Case, 'expected'>> = [
  {
    name: 'unknown session',
    why: 'Nothing cached — the whole history has to come down, from 0, without a wipe first.',
    probe: [p('s1', 100, 10)],
    cached: [],
  },
  {
    name: 'unchanged session',
    why: 'Watermark AND count level with the server is the only state that means "do nothing".',
    probe: [p('s1', 100, 10)],
    cached: [c('s1', 100, 10)],
  },
  {
    name: 'watermark moved forward',
    why: 'The ordinary case: fetch the delta from where the cache stopped, do not wipe.',
    probe: [p('s1', 200, 12)],
    cached: [c('s1', 100, 10)],
  },
  {
    name: 'watermark moved BACKWARD',
    why: 'Server watermark older than the cached one (a clock step, or rows restored from a backup). Not a wipe — count did not shrink — so `since` ends up AHEAD of the server. Whether that is right is a separate question; the port has to reproduce it.',
    probe: [p('s1', 50, 10)],
    cached: [c('s1', 100, 10)],
  },
  {
    name: 'count shrank',
    why: 'A row was deleted (dequeue / clearQueue). MAX(updatedAt) cannot see that and a delta cannot repair it, so wipe and refetch from 0.',
    probe: [p('s1', 100, 8)],
    cached: [c('s1', 100, 10)],
  },
  {
    name: 'count grew at the same watermark',
    why: 'Possible when two rows share a millisecond. Still a delta, not a wipe.',
    probe: [p('s1', 100, 11)],
    cached: [c('s1', 100, 10)],
  },
  {
    name: 'count shrank AND watermark moved',
    why: 'Both signals at once. The wipe wins: `since` is 0, not the cached watermark.',
    probe: [p('s1', 300, 8)],
    cached: [c('s1', 100, 10)],
  },
  {
    name: 'session the server no longer reports',
    why: 'Deleted upstream. Dropped, and never fetched.',
    probe: [p('s1', 100, 10)],
    cached: [c('s1', 100, 10), c('gone', 50, 3)],
  },
  {
    name: 'empty probe drops everything',
    why: 'Also pins the ORDER of `drop`: it is the order `cached` came in, not sorted and not hashed.',
    probe: [],
    cached: [c('d', 4, 4), c('a', 1, 1), c('c', 3, 3), c('b', 2, 2)],
  },
  {
    name: 'empty probe and empty cache',
    why: 'A first run before the server has answered. Three empty lists, not a crash.',
    probe: [],
    cached: [],
  },
  {
    name: 'fetches are newest-activity first',
    why: 'A cold start makes searchable first what the user was just talking about.',
    probe: [p('old', 10, 1), p('new', 999, 1), p('mid', 500, 1)],
    cached: [],
  },
  {
    name: 'equal watermarks keep probe order',
    why: 'The comparator returns 0 for a tie and Array.prototype.sort is stable, so the server order survives. Swift `sort` is documented as NOT stable — this case is the one that catches a naive port.',
    probe: [p('z', 100, 1), p('y', 100, 1), p('x', 100, 1), p('w', 100, 1), p('v', 100, 1), p('u', 100, 1), p('t', 100, 1), p('s', 100, 1), p('r', 100, 1), p('q', 100, 1), p('pp', 100, 1), p('o', 100, 1), p('n', 100, 1), p('m', 100, 1), p('l', 100, 1), p('k', 100, 1), p('j', 100, 1), p('i', 100, 1), p('h', 100, 1), p('g', 100, 1), p('f', 100, 1), p('e', 100, 1), p('d', 100, 1), p('cc', 100, 1), p('b', 100, 1), p('a', 100, 1)],
    cached: [],
  },
  {
    name: 'ties inside a sorted run keep probe order',
    why: 'Same stability question, but with the tie in the middle of real ordering work rather than across the whole array.',
    probe: [p('a', 500, 1), p('b', 100, 1), p('c', 900, 1), p('d', 100, 1), p('e', 500, 1), p('f', 100, 1)],
    cached: [],
  },
  {
    name: 'duplicated id in the probe',
    why: 'Both rows are planned — the loop is over the probe, not over the ids — while `live` collapses them. A port keyed on a dictionary would silently drop one.',
    probe: [p('s1', 100, 10), p('s1', 90, 9)],
    cached: [],
  },
  {
    name: 'duplicated id in the cache',
    why: 'The Map keeps the LAST one, so the second entry decides the plan. `set` overwrites; it does not ignore.',
    probe: [p('s1', 100, 10)],
    cached: [c('s1', 100, 10), c('s1', 40, 4)],
  },
  {
    name: 'zero watermark and zero count',
    why: 'A session with no messages. 0 === 0 is level, not missing — this must be upToDate, not a full fetch.',
    probe: [p('s1', 0, 0)],
    cached: [c('s1', 0, 0)],
  },
  {
    name: 'cached count zero against a server that has rows',
    why: 'An interrupted first sync. Delta from watermark 0, which is the same rows a full fetch would bring.',
    probe: [p('s1', 500, 3)],
    cached: [c('s1', 0, 0)],
  },
  {
    name: 'negative watermark',
    why: 'Not reachable through the API today, but it is a plain number, and it pins the comparator on values either side of zero.',
    probe: [p('a', -5, 1), p('b', 5, 1), p('c', 0, 1)],
    cached: [],
  },
  {
    name: 'a watermark past 2^31',
    why: 'Every real watermark is one: epoch milliseconds passed 2^31 in 1970+24 years. A port that reached for a 32-bit integer would truncate here.',
    probe: [p('s1', 1757030400000, 2)],
    cached: [c('s1', 1757030300000, 1)],
  },
  {
    name: 'metadata rides along on the probe row',
    why: 'The plan carries the PROBE row, not the cached one, so a renamed session or a fresh preview reaches the writer even when only the metadata changed.',
    probe: [p('s1', 200, 10, { agentName: 'brain', title: '标题变了', preview: '最后一句话' })],
    cached: [c('s1', 100, 10, { title: '旧标题', preview: null })],
  },
  {
    name: 'metadata changed but the session is level',
    why: 'The counterpart: nothing is fetched, and the row that lands in `upToDate` is the SERVER\'s, so a caller refreshing titles from it gets the new one.',
    probe: [p('s1', 100, 10, { title: '新标题', preview: '新预览' })],
    cached: [c('s1', 100, 10, { title: '旧标题', preview: '旧预览' })],
  },
  {
    name: 'a realistic mixed pass',
    why: 'Everything at once, which is the only case that pins how the three lists interleave.',
    probe: [p('quiet', 300, 5), p('busy', 900, 40), p('trimmed', 700, 2), p('fresh', 800, 1)],
    cached: [c('busy', 850, 38), c('quiet', 300, 5), c('trimmed', 700, 9), c('vanished', 10, 1), c('alsoGone', 20, 2)],
  },
];

export function buildFixture(): { cases: Case[] } {
  return {
    cases: INPUTS.map((i) => ({ ...i, expected: planSync(i.probe, i.cached) })),
  };
}

export function renderFixture(): string {
  return JSON.stringify(buildFixture(), null, 2) + '\n';
}

export function checkedInFixture(): string {
  return readFileSync(join(REPO_ROOT, FIXTURE_JSON), 'utf8');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const out = join(REPO_ROOT, FIXTURE_JSON);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderFixture());
  console.log(`wrote      ${FIXTURE_JSON}  (${buildFixture().cases.length} cases)`);
}
