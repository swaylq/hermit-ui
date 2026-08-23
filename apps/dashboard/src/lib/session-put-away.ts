// "Put away" — the single rule for whether a chat is part of what you're working
// on right now. Archived (`closedAt`) and hidden (`hiddenAt`) mean the same thing
// to every list of sessions: put away, not gone. Lists drop them by default and
// offer one toggle that brings both back.
//
// A PINNED session is never put away, whatever its flags say. Pins live in
// localStorage (session-pins.ts), so the server-side cleanup sweep cannot see
// them and cannot spare a pinned chat — honouring the pin here is what stops an
// archive sweep from silently removing something the human explicitly pinned.
// (Archiving it is still fine: it stays visible, wearing its `closed` badge.)
//
// Shared by the sidebar recents (sidebar/recent-lists.tsx) and the agent detail
// sessions list (agent-detail-sheet.tsx) so the two can't drift into disagreeing
// about what a list shows by default.

type PutAwayFlags = {
  id: string;
  hiddenAt?: Date | string | null;
  closedAt?: Date | string | null;
};

export function isSessionPutAway(s: PutAwayFlags, pins?: Set<string>): boolean {
  if (pins?.has(s.id)) return false;
  return Boolean(s.hiddenAt) || Boolean(s.closedAt);
}
