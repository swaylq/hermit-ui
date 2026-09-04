/**
 * Renders `apps/ios/tools/fixtures/search-cases.json` — a corpus, a list of
 * queries, and the hits THIS `searchCorpus` returns for them, today.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:search-fixture
 *
 * Companion to gen-sync-plan-fixture.ts, for the second pure function the iOS
 * app reimplements (`ChatCache.search`). The phone answers with a SQLite FTS5
 * index where the browser answers with a linear scan, so the two will never
 * share an implementation — which makes sharing the ANSWERS the only way they
 * stay the same product. A hit is a snippet plus highlight ranges, and getting
 * either off by one is invisible until someone reads a search result.
 *
 * The corpus below is deliberately awkward in the ways this one is not:
 * overlapping matches, a match at offset 0, a match inside the padding of
 * another, mixed case, an emoji before a match (surrogate pairs, which is where
 * UTF-16 offsets and Swift Characters part ways), and a row long enough to
 * truncate on both sides.
 *
 * `scanned` is NOT compared on the Swift side: the web counts rows it walked and
 * an index means most rows are never walked. Everything else is compared field
 * for field.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { searchCorpus, toEntry, type SearchOptions } from '../src/lib/chat-cache/search-core';
import type { CachedText, SearchResult } from '../src/lib/chat-cache/types';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURE_JSON = 'apps/ios/tools/fixtures/search-cases.json';

const t = (id: string, sessionId: string, createdAt: string, text: string, role = 'user'): CachedText => ({
  id,
  sessionId,
  role,
  createdAt,
  text,
});

const CORPUS: CachedText[] = [
  t('m1', 's1', '2026-09-01T10:00:00.000Z', '义脑要把时间线原生化，时间线是最贵的一块。'),
  t('m2', 's1', '2026-09-01T10:00:01.000Z', '时间线'),
  t('m3', 's1', '2026-09-01T10:00:02.000Z', 'SQLite 的 FTS5 用 trigram 分词，sqlite 的默认 unicode61 对中文没用。', 'assistant'),
  t('m4', 's2', '2026-09-01T09:00:00.000Z', 'aaaa'),
  t('m5', 's2', '2026-09-01T11:00:00.000Z', '🎉🎉🎉 庆祝一下，时间线终于原生了'),
  t('m6', 's2', '2026-09-01T11:00:00.000Z', '同一毫秒的第二条，时间线'),
  t(
    'm7',
    's3',
    '2026-09-02T08:00:00.000Z',
    '前面这段话足够长，长到把匹配的位置推到片段窗口之外，' +
      '于是左边要截断。'.repeat(6) +
      '这里出现关键词时间线，然后后面同样要足够长，' +
      '于是右边也要截断。'.repeat(6),
  ),
  t('m8', 's3', '2026-09-02T08:00:01.000Z', 'Hermit HERMIT hermit HeRmIt'),
  t('m9', 's3', '2026-09-02T08:00:02.000Z', '空的一条,没有关键词'),
  t('m10', 's1', '2026-09-03T00:00:00.000Z', '时间线时间线时间线时间线'),
];

type Case = {
  name: string;
  why: string;
  query: string;
  options: SearchOptions;
  expected: SearchResult;
};

const INPUTS: Array<Omit<Case, 'expected'>> = [
  { name: 'two-character Chinese query', why: 'The query a trigram index CANNOT answer — under three characters. On this corpus it is also the most natural thing to type.', query: '义脑', options: {} },
  { name: 'three-character Chinese query', why: 'The first length the index can hold. Must return exactly what the scan does.', query: '时间线', options: {} },
  { name: 'repeated match in one row', why: 'Non-overlapping: matches resume after the needle, so four occurrences are four, and the ranges inside the snippet are all of them.', query: '时间线', options: { sessionId: 's1' } },
  { name: 'overlapping candidates', why: '"aa" in "aaaa" is TWO matches, not three — the walk does not back up.', query: 'aa', options: {} },
  { name: 'match at offset zero', why: 'The snippet start clamps at 0 and truncatedLeft is false.', query: '时间线', options: { sessionId: 's1', order: 'chronological' } },
  { name: 'truncated on both sides', why: 'The window is SNIPPET_PAD either side of the FIRST match, in UTF-16 units.', query: '关键词', options: {} },
  { name: 'emoji before the match', why: 'Three emoji are six UTF-16 units and three Swift Characters. Offsets are in the former.', query: '原生', options: { sessionId: 's2' } },
  { name: 'case-insensitive latin', why: 'A query with a cased letter folds both sides; four spellings in one row are four matches.', query: 'hermit', options: {} },
  { name: 'case-insensitive latin, upper query', why: 'Same answer from the other direction.', query: 'HERMIT', options: {} },
  { name: 'digits only', why: 'needsCaseFold is false, so the haystack is never lowercased — and there is nothing to find.', query: '2026', options: {} },
  { name: 'no hits', why: 'Empty everything, not a crash.', query: '不存在的词', options: {} },
  { name: 'empty query', why: 'Trimmed to nothing: an early return, and `scanned` is 0 even though the corpus is not.', query: '   ', options: {} },
  { name: 'limit of two', why: 'totalHits and totalMessages count past the page; hits do not.', query: '时间线', options: { limit: 2 } },
  { name: 'limit of zero means everything', why: 'The in-session find asks for all of them so ↑/↓ can say "3 / 47".', query: '时间线', options: { limit: 0 } },
  { name: 'chronological order', why: 'The in-session find walks the conversation the way the timeline scrolls.', query: '时间线', options: { order: 'chronological' } },
  { name: 'same millisecond ties break on id', why: 'm5 and m6 share a createdAt. Without the id tie-break their order would flip between passes.', query: '时间线', options: { sessionIds: ['s2'], order: 'chronological' } },
  { name: 'session filter', why: 'The in-session find. `scanned` drops to that session only.', query: '时间线', options: { sessionId: 's3' } },
  { name: 'agent filter over several sessions', why: 'The overlay resolves agent → sessions itself; the corpus rows carry no agent name.', query: '时间线', options: { sessionIds: ['s1', 's3'] } },
  { name: 'agent filter matching nothing', why: 'An empty allow-list is a real answer, not "no filter".', query: '时间线', options: { sessionIds: [] } },
  { name: 'query with a double quote', why: 'FTS5 phrase syntax escapes `"` by doubling it. The web has no such syntax, so only the phone can get this wrong.', query: 'say "hi"', options: {} },
  { name: 'query with FTS5 operators', why: '`*`, `-`, `NEAR` and `OR` are literal inside a phrase. A port that pasted the query in unquoted would return the wrong rows, or an error.', query: 'NEAR OR -x*', options: {} },
  { name: 'query with a LIKE wildcard', why: 'Under three characters, so it goes down the LIKE path where `%` and `_` must be escaped.', query: '%_', options: {} },
];

export function buildFixture() {
  return {
    corpus: CORPUS,
    cases: INPUTS.map((i) => ({
      ...i,
      // Fresh entries per case: `toEntry` caches a folded copy, which is an
      // optimization, not a result — but a shared cache would make the table
      // depend on the ORDER the cases run in.
      expected: searchCorpus(CORPUS.map(toEntry), i.query, i.options),
    })),
  };
}

export function renderFixture(): string {
  const { corpus, cases } = buildFixture();
  return JSON.stringify({ corpus, cases }, null, 2) + '\n';
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
