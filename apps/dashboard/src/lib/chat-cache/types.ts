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
