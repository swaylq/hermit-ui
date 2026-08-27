// Shared shapes for the browser-local chat cache. Kept dependency-free so the
// pure search core and its tests can import them without React or tRPC.

// One message's searchable prose. This is the FULL-HISTORY layer: every message
// of every session in the active workspace, ~11 MB for the production machine.
export type CachedText = {
  id: string;
  sessionId: string;
  role: string;
  createdAt: string; // ISO — kept as a string so it survives structured-clone
  text: string;
  // Renderable blocks that carry no prose — interaction cards (a question and
  // the option that was picked). Absent for the overwhelming majority of rows.
  // Present so summary-mode history served from this cache is complete; search
  // ignores them, exactly as it ignored these rows before.
  blocks?: unknown[];
  // Absent for the human-typed majority; 'brain' / 'system' otherwise. Summary
  // mode renders from this layer, so without it a conversation the Brain drove
  // would read back as if the human had said all of it.
  authoredBy?: string | null;
};

// Per-session sync bookkeeping + the metadata a search hit renders with. Mirrors
// one row of chat.syncProbe once that session is fully synced locally.
export type CachedSession = {
  sessionId: string;
  agentName: string;
  title: string | null;
  preview: string | null;
  watermark: number; // MAX(updatedAt) in ms, as of the last completed sync
  count: number; // server row count, as of the last completed sync
};

// One message as the TIMELINE renders it — the capped content blocks, not just
// prose. This is the RECENT layer: only the LRU-retained sessions, so a session
// you've opened before paints from disk instead of waiting on the network.
export type CachedFullRow = {
  id: string;
  sessionId: string;
  role: string;
  content: unknown;
  createdAt: string;
  // Who spoke, for role='user' rows: null/absent = the human, 'brain' = the Brain
  // during a takeover, 'system' = a gateway poke. Cached because the timeline
  // paints from here first — without it, reopening a session the Brain drove would
  // show its messages as the human's until the network fetch landed.
  authoredBy?: string | null;
  /**
   * The row that comes immediately AFTER this one in the conversation.
   *
   * Every write into these stores is a run the server handed over in one piece —
   * a live window, or one page of history — so each row's neighbour inside that
   * run is known at write time and can be recorded. A read then PROVES the page
   * it serves is unbroken by walking these links back from the anchor, instead
   * of assuming that whatever the store happens to hold is contiguous.
   *
   * It is not. The store accumulates windows written minutes apart, and a
   * session busy enough to slide the window further than its own width between
   * two writes leaves a gap between them. Serving a page across that gap hands
   * the timeline a hole that survives every reload, because the pager only ever
   * walks further back — 162 messages and fifteen minutes of one, in the case
   * this was written for.
   *
   * Absent means "unknown", which is what an old cached row and the newest row
   * of a live window both are; a read refuses rather than guesses.
   */
  nextId?: string | null;
};

// One translated markdown block, keyed by a hash of its SOURCE text plus the
// target language — never by message id, because the gateway swaps the row id
// mid-reply and because the same paragraph quoted twice is the same work.
//
// Lives in the scoped cache database like everything else here: a translation
// is message content, so signing out of a machine must take it with it
// (pruneForeignScopes).
export type CachedTranslation = {
  key: string;
  text: string;
  lastUsedAt: number;
};

// LRU bookkeeping for the `full` store.
export type FullMeta = {
  sessionId: string;
  lastUsedAt: number;
};

// A search hit: the message, plus where in its text the query matched.
export type SearchHit = {
  id: string;
  sessionId: string;
  role: string;
  createdAt: string;
  // A window of text around the first match, with match offsets relative to the
  // snippet (not the full text) so the renderer can highlight without re-scanning.
  snippet: string;
  ranges: Array<[start: number, end: number]>;
  truncatedLeft: boolean;
  truncatedRight: boolean;
  matchCount: number; // matches within THIS message
};

export type SearchResult = {
  query: string;
  hits: SearchHit[];
  totalHits: number; // matches across all messages, even beyond the returned page
  totalMessages: number; // messages containing at least one match
  scanned: number; // how many messages were scanned, for the "indexing…" hint
};
