// Substring search over the cached prose. Pure and dependency-free, so the
// matching rules are driven directly by node:test.
//
// WHY SUBSTRING AND NOT AN INVERTED INDEX — the corpus is Chinese. Every
// mainstream JS full-text library (MiniSearch, FlexSearch, Lunr) tokenizes on
// whitespace and punctuation, which turns a Chinese sentence into one enormous
// token; searching "义脑" then matches nothing unless you bolt on a bigram
// tokenizer, and a bigram index costs 2-4× the corpus in extra bytes. A linear
// indexOf scan needs no tokenizer, is exactly right for CJK, and matches what
// the in-session find already did — so the two searches agree on what a "match"
// is. Measured against the production corpus (~11 MB of prose across 193k
// messages) a full scan is tens of milliseconds, and it degrades linearly: at
// the current ~7-10 MB/month growth there's headroom for years. When that stops
// being true, this module is the only thing that has to change — every caller
// is already expressed in terms of hits, not indexes.
//
// NO UNICODE NORMALIZATION. NFKC would let a full-width ＡＢＣ match ABC, but it
// changes string lengths, and every match offset here is used to slice the
// ORIGINAL text for the snippet. Exact offsets beat fuzzy folding.

import type { CachedText, SearchHit, SearchResult } from './types';

// One corpus row plus its lazily-built case-folded copy. `lower` is filled only
// when a query actually needs case-insensitive matching (i.e. it contains a
// Latin letter). A pure-CJK query — the common case here — never allocates it,
// which keeps resident memory at roughly one copy of the prose instead of two.
export type CorpusEntry = {
  row: CachedText;
  lower: string | null;
};

export function toEntry(row: CachedText): CorpusEntry {
  return { row, lower: null };
}

// Case folding only matters if the query has a character whose case can differ.
// `toLowerCase` is a no-op for Han, Kana, digits and punctuation.
export function needsCaseFold(query: string): boolean {
  return query.toLowerCase() !== query.toUpperCase();
}

const SNIPPET_PAD = 70;
const DEFAULT_PAGE = 100;
// Matches counted per message. A pathological row (a 12k-char block, a 1-char
// query) would otherwise push thousands of offsets into a result that shows one
// snippet.
const MAX_MATCHES_PER_ROW = 200;

export function findMatches(haystack: string, needle: string, cap = MAX_MATCHES_PER_ROW): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1 && out.length < cap) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

// Build the displayable hit for one row: a window around the FIRST match, with
// every match range that lands inside that window rebased to snippet coordinates.
export function buildHit(row: CachedText, offsets: number[], qLen: number): SearchHit {
  const first = offsets[0];
  const start = Math.max(0, first - SNIPPET_PAD);
  const end = Math.min(row.text.length, first + qLen + SNIPPET_PAD);
  const snippet = row.text.slice(start, end);
  const ranges: Array<[number, number]> = [];
  for (const o of offsets) {
    if (o >= start && o + qLen <= end) ranges.push([o - start, o - start + qLen]);
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    createdAt: row.createdAt,
    snippet,
    ranges,
    truncatedLeft: start > 0,
    truncatedRight: end < row.text.length,
    matchCount: offsets.length,
  };
}

export type SearchOptions = {
  // 0 = every match. The global overlay pages at DEFAULT_PAGE; the in-session
  // find asks for all of them, because ↑/↓ stepping needs the complete list to
  // report "3 / 47" and to know where the 47th is.
  limit?: number;
  sessionId?: string; // restrict to one session (drives the in-session find)
  // Restrict to these sessions (drives the global overlay's agent filter). A
  // session is allowed iff its id is in the set, so the caller pre-resolves the
  // agent → sessions mapping — the corpus rows carry no agent name.
  sessionIds?: readonly string[];
  // 'newest' for the global overlay (recency is the only ranking a chat log
  // supports); 'chronological' for the in-session find, so ↑/↓ walk the
  // conversation in the same direction the timeline scrolls.
  order?: 'newest' | 'chronological';
};

function cmpRow(a: CachedText, b: CachedText): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function searchCorpus(corpus: CorpusEntry[], query: string, opts: SearchOptions = {}): SearchResult {
  const q = query.trim();
  const limit = opts.limit ?? DEFAULT_PAGE;
  if (!q) return { query: q, hits: [], totalHits: 0, totalMessages: 0, scanned: 0 };

  const fold = needsCaseFold(q);
  const needle = fold ? q.toLowerCase() : q;
  const allowed = opts.sessionIds ? new Set(opts.sessionIds) : null;

  const matched: Array<{ entry: CorpusEntry; offsets: number[] }> = [];
  let totalHits = 0;
  let scanned = 0;
  for (const entry of corpus) {
    if (allowed && !allowed.has(entry.row.sessionId)) continue;
    if (opts.sessionId && entry.row.sessionId !== opts.sessionId) continue;
    scanned++;
    let hay = entry.row.text;
    if (fold) {
      if (entry.lower === null) entry.lower = entry.row.text.toLowerCase();
      hay = entry.lower;
    }
    // Cheap reject before the offset walk — indexOf on a miss is the whole cost
    // of the scan, so avoid doing it twice.
    if (hay.indexOf(needle) === -1) continue;
    const offsets = findMatches(hay, needle);
    if (offsets.length === 0) continue;
    totalHits += offsets.length;
    matched.push({ entry, offsets });
  }

  const chronological = opts.order === 'chronological';
  matched.sort((a, b) => (chronological ? cmpRow(a.entry.row, b.entry.row) : -cmpRow(a.entry.row, b.entry.row)));

  const page = limit > 0 ? matched.slice(0, limit) : matched;
  return {
    query: q,
    hits: page.map((m) => buildHit(m.entry.row, m.offsets, q.length)),
    totalHits,
    totalMessages: matched.length,
    scanned,
  };
}
