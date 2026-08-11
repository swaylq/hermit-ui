// The ONE recency key the session lists use — server-side ordering and the timestamp
// the row prints both read from here, on purpose.
//
// A session gets `lastMessageAt` only once someone has spoken in it; until then the
// column is null and the only thing that says when it happened is `startedAt`. Every
// list has always DISPLAYED that fallback. What kept going wrong was the sort: SQL
// has no fallback, so `lastMessageAt DESC NULLS LAST` filed every never-messaged
// session below conversations from months ago — while the row it produced read
// "1d ago". A brand-new chat landed at the very bottom of the sidebar.
//
// Keep the two derived from one function and they cannot disagree again. If you add
// a list of sessions, order it by `sessionRecencyMs` and print `sessionRecencyAt`.

export type SessionRecency = {
  lastMessageAt?: Date | string | null;
  startedAt: Date | string;
};

/** When the session last saw activity: last message, else when it was created. */
export function sessionRecencyAt(s: SessionRecency): Date | string {
  return s.lastMessageAt ?? s.startedAt;
}

/** Same key as epoch ms, for sorting. Newest-first is `b - a`. */
export function sessionRecencyMs(s: SessionRecency): number {
  const at = sessionRecencyAt(s);
  return typeof at === 'string' ? new Date(at).getTime() : at.getTime();
}
