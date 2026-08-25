// Shape of a push-worthy event. Produced at the four gateway write points
// (chat-message / interaction / cron-run / host-stat sync routes) plus the
// unanswered-message sweep, consumed by server/push/index.ts.
// See docs/ios-shell-design.md and docs/unanswered-alert-design.md.

export type PushKind =
  | 'blocked' // an agent is stopped waiting on a permission / question decision
  | 'chat' // an agent replied in a session
  | 'cron' // a scheduled task reported: its result into a chat (cronReportEvent),
  //          or a bad ending — timeout / error / no_output — onto /cron (cronEvent)
  | 'host' // a machine crossed into red resource pressure
  | 'stall'; // the human asked something and nothing answered (server/unanswered.ts)

export interface PushEvent {
  kind: PushKind;
  machineId: string;
  title: string;
  body: string;
  /** Path the app navigates to on tap, e.g. `/chat?session=abc`. */
  path: string;
  /**
   * Notification identity. Two pushes with the same key REPLACE each other on the
   * lock screen (APNs `apns-collapse-id`) instead of stacking — so one session /
   * cron / machine never occupies more than one slot. Max 64 bytes per APNs.
   */
  collapseKey: string;
  /** Set for session-bound events; enables the "you're already looking at it" check. */
  sessionId?: string;
}
