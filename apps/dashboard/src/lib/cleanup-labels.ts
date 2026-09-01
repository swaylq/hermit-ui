// Human-facing text for a cleanup verdict — why a session was proposed for the
// bin, or why it was spared.
//
// Mirrors the tables in server/session-cleanup.ts, and lives here rather than
// being imported from there because that module imports prisma: a client bundle
// that pulled it in would drag the whole DB client into the browser. Two files,
// one meaning — keep them in step when a reason or a blocker is added.

export const REASON_LABEL: Record<string, string> = {
  'dispatch-done': 'finished dispatch — its result was already reported back',
  stillborn: 'never got a reply — a failed spawn, not a conversation',
  empty: 'no messages at all',
  'agent-trashed': 'its agent is in the trash',
  idle: 'archived and untouched since',
  manual: 'cleaned by hand',
  blocked: 'something still points at it',
};

export const BLOCKER_LABEL: Record<string, string> = {
  cron: 'a cron reports into it',
  unread: 'its last message is unread',
  interaction: 'waiting on an answer from you',
  queued: 'has an undelivered message',
  unanswered: 'flagged: you asked, nobody answered',
  working: 'working right now',
  dispatch: 'wired to a Brain dispatch or takeover',
  grouped: 'filed in a group',
  named: 'you gave it a name',
  kept: 'you marked it Keep',
};

/** Disk size. NOT `format.ts`'s fmtBytes — that one counts tokens despite its name. */
export function fmtSize(n: number): string {
  if (!n) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
