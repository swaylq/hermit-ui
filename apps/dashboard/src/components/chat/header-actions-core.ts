// ── The chat header's right-hand action cluster, as data ─────────────────────
//
// Which buttons the cluster has, which of them fold into the phone's overflow
// tray, which are disabled, and the two-step confirm's state machine. No React,
// no DOM — so the iOS port (`apps/ios/Hermit/HeaderActionsCore.swift`) can run
// this same table and a disagreement is always between two implementations
// rather than between an implementation and someone's reading of the JSX.
//
// The rules used to live inline in `app/chat/page.tsx`'s JSX and in
// `confirm-icon-button.tsx`'s `useState`. They are lifted here rather than
// copied: both files call into this, so the fixture cannot end up comparing
// Swift against dead code.

/**
 * How long the armed pill waits before it will accept a click.
 *
 * The tap that ARMS and the tap that confirms land on the same pixels (the pill
 * grows leftward from a right-anchored icon, and the confirm half is rendered
 * LAST so it covers them), so with no dead time a double-tap would confirm a
 * destructive action the user only pointed at once. 350ms is just past iOS's
 * ~300ms double-tap window. A click inside it is ignored and the pill STAYS
 * ARMED, so the next tap still works; nothing is silently swallowed.
 */
export const ARM_GUARD_MS = 350;

/**
 * How long the pill stays armed with no input. Long enough to read on a phone,
 * short enough that a stray confirm can't be collected minutes later.
 */
export const AUTO_DISARM_MS = 5_000;

/**
 * The width at which the secondary group stops folding into the tray. It is a
 * CONTAINER query on the chat column (`@min-[40rem]`), not the viewport: the
 * live-preview split narrows the column without narrowing the window, and the
 * header has to fold when its own row runs out of room.
 */
export const SECONDARY_FOLD_PX = 640;

export function secondaryFolds(headerWidthPx: number): boolean {
  return headerWidthPx < SECONDARY_FOLD_PX;
}

export type HeaderActionId =
  | 'restore'
  | 'pureChat'
  | 'detail'
  | 'find'
  | 'compact'
  | 'restart'
  | 'more'
  | 'newChat'
  | 'terminal'
  | 'delete';

/**
 * `persistent` is on the header row at every width. `secondary` is the group
 * that folds — inline while the column is wide, in the ⋯ tray below that.
 */
export type HeaderActionGroup = 'persistent' | 'secondary';

export interface HeaderActionSpec {
  id: HeaderActionId;
  group: HeaderActionGroup;
  /** Two-step: the icon arms a pill, and the pill's right half fires. */
  confirm: boolean;
  /** What the armed half says. Absent → the generic "confirm". */
  confirmLabel?: string;
  danger: boolean;
  disabled: boolean;
  /** A request of this kind is in flight — the idle icon becomes "…". */
  busy: boolean;
  /** Toggles only (`find`, `more`): drawn lit while true. */
  pressed?: boolean;
}

export interface HeaderActionState {
  /**
   * Null until the session is known. Every "disabled" below that mentions it is
   * the same judgement: an action whose target has not loaded cannot fire.
   */
  session: {
    agentName?: string | null;
    runtime?: string | null;
    /** String off the wire, `Date` once a caller has parsed it — only its
     *  presence is ever asked about, so both are taken as-is. */
    closedAt?: string | Date | null;
    restartRequestedAt?: string | Date | null;
  } | null;
  /** A share link: no machine procedures, so no terminal. */
  scoped: boolean;
  creatingChat: boolean;
  deleting: boolean;
  restarting: boolean;
  reopening: boolean;
  findOpen: boolean;
  moreOpen: boolean;
  /** `hasTmuxPane(session.runtime)`, passed in so this file stays label-free. */
  hasTmuxPane: boolean;
}

/**
 * The cluster in DOM order: the persistent leading `restore`, then the five
 * that fold, then the tray toggle and the persistent trailing three.
 *
 * Actions that do not apply are ABSENT, not disabled — `restore` on a live
 * session and `terminal` on a paneless runtime are not "greyed out" on the web
 * either, they are not rendered. A renderer therefore never has to re-derive
 * visibility; it draws what it is handed.
 */
export function headerActions(s: HeaderActionState): HeaderActionSpec[] {
  const session = s.session;
  const closed = !!session?.closedAt;
  const out: HeaderActionSpec[] = [];

  // The way out of an archived chat. Persistent (never in the tray) and tinted,
  // because for a closed session it is the only action that does anything —
  // everything else is disabled and the composer just says "session is closed".
  if (closed) {
    out.push({ id: 'restore', group: 'persistent', confirm: false, danger: false,
      disabled: s.reopening, busy: s.reopening });
  }

  out.push({ id: 'pureChat', group: 'secondary', confirm: true, confirmLabel: 'pure chat',
    danger: false, disabled: !session?.agentName, busy: s.creatingChat });
  out.push({ id: 'detail', group: 'secondary', confirm: false, danger: false,
    disabled: false, busy: false });
  out.push({ id: 'find', group: 'secondary', confirm: false, danger: false,
    disabled: false, busy: false, pressed: s.findOpen });
  // compact SENDS a message, so a closed session cannot run it — unlike restart,
  // which only kills a pane and is merely pointless there.
  out.push({ id: 'compact', group: 'secondary', confirm: true, danger: false,
    disabled: !session || closed, busy: false });
  out.push({ id: 'restart', group: 'secondary', confirm: true, danger: false,
    disabled: !session, busy: !!session?.restartRequestedAt || s.restarting });

  out.push({ id: 'more', group: 'persistent', confirm: false, danger: false,
    disabled: false, busy: false, pressed: s.moreOpen });
  out.push({ id: 'newChat', group: 'persistent', confirm: false, danger: false,
    disabled: !session?.agentName || s.creatingChat, busy: false });
  // pi and codex sessions run as child processes with no tmux pane — the
  // terminal would attach to a pane that does not exist.
  if (!s.scoped && s.hasTmuxPane) {
    out.push({ id: 'terminal', group: 'persistent', confirm: false, danger: false,
      disabled: false, busy: false });
  }
  out.push({ id: 'delete', group: 'persistent', confirm: true, danger: true,
    disabled: !session, busy: s.deleting });

  return out;
}

/** Handy for renderers that ask "is this one here?" without scanning. */
export function headerActionIds(s: HeaderActionState): HeaderActionId[] {
  return headerActions(s).map((a) => a.id);
}

// ── The two-step confirm ─────────────────────────────────────────────────────

export type ConfirmState = { armed: false } | { armed: true; armedAt: number };

export const DISARMED: ConfirmState = { armed: false };

export type ConfirmEvent = 'press' | 'cancel' | 'confirm' | 'timeout';

export interface ConfirmOutcome {
  state: ConfirmState;
  /** True exactly on the step that should run the action. */
  fire: boolean;
}

/** Has the arming tap's bounce window passed? */
export function confirmSettled(state: ConfirmState, now: number): boolean {
  return state.armed && now - state.armedAt >= ARM_GUARD_MS;
}

/**
 * ORDER IS LOAD-BEARING, and it is encoded here as the guard rather than in the
 * layout: `cancel` and `confirm` arrive from the same pixels, so an unguarded
 * second tap in the same spot used to cancel what the first tap armed and
 * delete looked broken ("点击删除了还在", 2026-08-30).
 */
export function confirmStep(state: ConfirmState, event: ConfirmEvent, now: number): ConfirmOutcome {
  switch (event) {
    case 'press':
      // Re-pressing an armed control re-arms it rather than toggling off: the
      // idle icon is not on screen to press while the pill covers it.
      return { state: { armed: true, armedAt: now }, fire: false };
    case 'cancel':
      if (!state.armed) return { state, fire: false };
      return confirmSettled(state, now) ? { state: DISARMED, fire: false } : { state, fire: false };
    case 'confirm':
      if (!state.armed) return { state, fire: false };
      return confirmSettled(state, now) ? { state: DISARMED, fire: true } : { state, fire: false };
    case 'timeout':
      if (!state.armed) return { state, fire: false };
      return now - state.armedAt >= AUTO_DISARM_MS
        ? { state: DISARMED, fire: false }
        : { state, fire: false };
  }
}
