import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCorpus, findMatches, buildHit, needsCaseFold, toEntry } from './search-core';
import type { CachedText } from './types';

function row(id: string, text: string, opts: Partial<CachedText> = {}): CachedText {
  return {
    id,
    sessionId: opts.sessionId ?? 's1',
    role: opts.role ?? 'assistant',
    createdAt: opts.createdAt ?? '2026-07-01T00:00:00.000Z',
    text,
  };
}

const corpus = (rows: CachedText[]) => rows.map(toEntry);

test('findMatches walks non-overlapping occurrences', () => {
  assert.deepEqual(findMatches('aXbXcX', 'X'), [1, 3, 5]);
  assert.deepEqual(findMatches('aaaa', 'aa'), [0, 2]); // non-overlapping by design
  assert.deepEqual(findMatches('abc', 'z'), []);
  assert.deepEqual(findMatches('abc', ''), []);
});

test('findMatches respects its cap', () => {
  assert.equal(findMatches('x'.repeat(500), 'x', 10).length, 10);
});

// The whole reason this is substring search and not a tokenized index.
test('Chinese matches without any tokenizer', () => {
  const c = corpus([row('a', '今天把义脑的派活闭环做完了'), row('b', '无关内容')]);
  const r = searchCorpus(c, '义脑');
  assert.equal(r.totalMessages, 1);
  assert.equal(r.hits[0].id, 'a');
});

test('a Chinese query matches a substring inside a word, which a tokenizer would miss', () => {
  const r = searchCorpus(corpus([row('a', '资源治理方案')]), '源治');
  assert.equal(r.totalMessages, 1);
});

test('case folding applies to Latin and is skipped for CJK', () => {
  assert.equal(needsCaseFold('Hello'), true);
  assert.equal(needsCaseFold('义脑'), false);
  assert.equal(needsCaseFold('123 · 、'), false);

  const r = searchCorpus(corpus([row('a', 'Deploy the GATEWAY now')]), 'gateway');
  assert.equal(r.totalMessages, 1);
});

test('a pure-CJK query never materializes the lowercase mirror', () => {
  const entries = corpus([row('a', '义脑 dispatch')]);
  searchCorpus(entries, '义脑');
  assert.equal(entries[0].lower, null); // no wasted copy of the corpus
  searchCorpus(entries, 'Dispatch');
  assert.equal(typeof entries[0].lower, 'string');
});

test('counts every match, but pages the returned hits', () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    row(`m${i}`, 'needle needle', { createdAt: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z` })
  );
  const r = searchCorpus(corpus(rows), 'needle', { limit: 5 });
  assert.equal(r.hits.length, 5);
  assert.equal(r.totalMessages, 30);
  assert.equal(r.totalHits, 60); // two per message
});

test('limit 0 returns every hit — the in-session find needs the full list', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`m${i}`, 'needle'));
  assert.equal(searchCorpus(corpus(rows), 'needle', { limit: 0 }).hits.length, 30);
});

test('default order is newest first; chronological is opt-in', () => {
  const rows = [
    row('old', 'hit', { createdAt: '2026-07-01T00:00:00.000Z' }),
    row('new', 'hit', { createdAt: '2026-07-09T00:00:00.000Z' }),
  ];
  assert.equal(searchCorpus(corpus(rows), 'hit').hits[0].id, 'new');
  assert.equal(searchCorpus(corpus(rows), 'hit', { order: 'chronological' }).hits[0].id, 'old');
});

test('rows sharing a timestamp stay deterministically ordered', () => {
  const rows = [
    row('b', 'hit', { createdAt: '2026-07-01T00:00:00.000Z' }),
    row('a', 'hit', { createdAt: '2026-07-01T00:00:00.000Z' }),
  ];
  const asc = searchCorpus(corpus(rows), 'hit', { order: 'chronological' }).hits.map((h) => h.id);
  assert.deepEqual(asc, ['a', 'b']);
});

test('sessionId restricts the scan and the reported scan size', () => {
  const c = corpus([row('a', 'hit', { sessionId: 's1' }), row('b', 'hit', { sessionId: 's2' })]);
  const r = searchCorpus(c, 'hit', { sessionId: 's2' });
  assert.equal(r.totalMessages, 1);
  assert.equal(r.hits[0].id, 'b');
  assert.equal(r.scanned, 1);
});

test('empty query returns nothing rather than everything', () => {
  const r = searchCorpus(corpus([row('a', 'anything')]), '   ');
  assert.equal(r.hits.length, 0);
  assert.equal(r.totalMessages, 0);
});

test('snippet ranges are relative to the snippet, and slice the original text', () => {
  const long = `${'x'.repeat(200)}needle${'y'.repeat(200)}`;
  const hit = buildHit(row('a', long), findMatches(long, 'needle'), 'needle'.length);
  assert.equal(hit.truncatedLeft, true);
  assert.equal(hit.truncatedRight, true);
  const [s, e] = hit.ranges[0];
  assert.equal(hit.snippet.slice(s, e), 'needle');
});

test('a match at the very start is not reported as left-truncated', () => {
  const hit = buildHit(row('a', 'needle at the front'), [0], 6);
  assert.equal(hit.truncatedLeft, false);
  assert.deepEqual(hit.ranges[0], [0, 6]);
});

test('only matches inside the snippet window get ranges', () => {
  const text = `needle${'z'.repeat(500)}needle`;
  const hit = buildHit(row('a', text), findMatches(text, 'needle'), 6);
  assert.equal(hit.matchCount, 2); // both counted…
  assert.equal(hit.ranges.length, 1); // …only the one in view is highlightable
});

test('CJK snippet offsets survive — no normalization is applied', () => {
  const text = '前面的内容'.repeat(30) + '关键词' + '后面的内容'.repeat(30);
  const hit = buildHit(row('a', text), findMatches(text, '关键词'), 3);
  const [s, e] = hit.ranges[0];
  assert.equal(hit.snippet.slice(s, e), '关键词');
});
