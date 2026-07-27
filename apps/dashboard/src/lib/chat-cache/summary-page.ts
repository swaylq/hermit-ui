// Paging summary-mode history out of the local cache.
//
// Summary mode renders prose: `text` blocks, plus the interaction cards a person
// was actually shown. The search cache already stores exactly that, for every
// message of every session in the workspace (~11 MB) — so the history a summary
// reader scrolls back through is already on disk and needs no network at all.
//
// That also fixes the exchange rate. Server paging counts RAW messages, and raw
// messages collapse hard: measured on a 3,968-message session, 60 raw rows
// yielded 13 visible ones, so a reader was pulling 1.1 MB to put 120 rows on
// screen — three quarters of it tool output, filtered out after it arrived.
// A page here is counted in rows you will actually see.
//
// Old history is append-only, which is what makes this safe: the gateway's
// in-place upserts only ever touch the row it is streaming, so anything behind
// the live window is final. A session that has ever completed a sync has all of
// its old prose, whatever has happened since.

export type CachedRow = {
  id: string;
  role: string;
  createdAt: string;
  text: string;
  /** Renderable blocks that aren't prose — interaction cards. */
  blocks?: unknown[];
};

export type SummaryRow = {
  id: string;
  role: string;
  createdAt: string;
  content: unknown[];
};

/** Where the loaded timeline currently starts; the page ends just before it. */
export type Edge = { createdAt: string; id: string };

// The harness's end-of-turn marker is prose, so the cache keeps it, but the
// timeline drops it — it is machinery, not conversation. Matching the timeline
// here keeps a cache-served page identical to a server-served one.
const TERMINATOR = /^no response requested\.?$/i;

/** (createdAt, id) — the same total order the server pages by. */
function before(a: { createdAt: string; id: string }, b: Edge): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

function usable(r: CachedRow): boolean {
  if (r.blocks && r.blocks.length > 0) return true;
  if (!r.text.trim()) return false;
  return !TERMINATOR.test(r.text.trim());
}

function toRow(r: CachedRow): SummaryRow {
  return {
    id: r.id,
    role: r.role,
    createdAt: r.createdAt,
    content: r.blocks && r.blocks.length > 0 ? r.blocks : [{ type: 'text', text: r.text }],
  };
}

/**
 * The `pageSize` newest rows that still sit strictly before `edge`, oldest
 * first — i.e. one "load earlier" worth of summary history.
 *
 * `edge` is passed as (createdAt, id) rather than an id because the row the
 * timeline currently starts at is often NOT in this cache: it can be a tool
 * result, which has no prose. Positioning by order rather than by lookup means
 * the seam lands in the right place either way.
 */
export function summaryPage(
  rows: CachedRow[],
  edge: Edge | null,
  pageSize: number
): { rows: SummaryRow[]; hasMore: boolean } {
  const ordered = rows
    .filter(usable)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1));
  const older = edge ? ordered.filter((r) => before(r, edge)) : ordered;
  const start = Math.max(0, older.length - pageSize);
  return { rows: older.slice(start).map(toRow), hasMore: start > 0 };
}
