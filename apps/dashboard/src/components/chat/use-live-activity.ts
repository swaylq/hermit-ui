'use client';

// Drives the iOS Lock Screen / Dynamic Island activity for the open session.
//
// Why it lives on the chat page rather than somewhere global: only this pane
// knows the moment a turn begins. Everything AFTER that moment is the server's
// job — it holds the activity's push token and updates it while the phone is
// locked, which is the only time any of this matters. So the shape here is
// deliberately small: raise it, keep it honest while you are looking at it, take
// it down.
//
// Three rules the signature enforces, each of which cost something to learn
// elsewhere in this repo:
//
//  · **Never send elapsed time.** The widget draws its own timer from a single
//    start stamp, ticking once a second with nothing behind it. Putting a
//    duration in the payload would mean a push per second — which Apple budgets
//    against you and eventually just drops. `session-state-push.ts` excludes
//    `elapsedSec` from its signature for exactly this reason.
//  · **Only push on change.** Same reason, and the change test is on the fields
//    a person would notice, not on object identity: the 5s poll hands us a fresh
//    `activity` object every time with identical contents.
//  · **Say something, or say nothing.** A blank line on a Lock Screen is worse
//    than no activity at all, so a phase with nothing to report falls back to a
//    plain description of the state rather than an empty string.

import { useEffect, useRef, useState } from 'react';
import {
  isNativeShell,
  getLiveActivitySupport,
  onLiveActivitySupport,
  liveActivityStart,
  liveActivityUpdate,
  liveActivityEnd,
  type LiveActivityPhase,
  type LiveActivityState,
} from '@/lib/native-bridge';
import { getActiveEntry, getKeyring } from '@/lib/keyring';
import { shortDuration } from '@/lib/session-status';
import { ctxPct } from '@/lib/format';

export interface LiveActivityInput {
  sessionId: string | undefined;
  agentName: string | undefined | null;
  title: string | undefined | null;
  /** `sessionStatusView(...).key` — the same value the header dot reads, so the
   *  Lock Screen and the header can never disagree about the state. */
  statusKey: string;
  /** The activity chip's two primitives, already stripped of elapsed time
   *  (chat/page.tsx builds them for the run capsule for the same reason). */
  activityLabel: string | null;
  activityDetail: string | null;
  queued: number;
  /** Tokens in the context window, and how many it holds. Both straight off the
   *  session row, so the island cannot disagree with the header about how full
   *  it is. */
  contextTokens: number | null | undefined;
  contextWindow: number;
}

/** The states the island distinguishes. Anything not working and not waiting on
 *  a human is over as far as a Lock Screen is concerned. */
function phaseOf(statusKey: string): LiveActivityPhase {
  if (statusKey === 'needs-you') return 'blocked';
  if (statusKey === 'working') return 'working';
  return 'done';
}

function lineFor(
  phase: LiveActivityPhase,
  i: Pick<LiveActivityInput, 'activityLabel' | 'activityDetail'>,
  ranForMs: number,
): string {
  if (phase === 'blocked') {
    // The question itself would be better, but it lives in the interaction row
    // and not every block has one — a permission prompt is a tool name. The
    // label is what the header already shows for this state.
    return i.activityLabel ?? '等你回答';
  }
  if (phase === 'working') {
    const label = i.activityLabel;
    const detail = i.activityDetail;
    if (label && detail) return `${label} · ${detail}`;
    return label ?? detail ?? '正在处理';
  }
  // Finished.
  //
  // Not the reply's first line, though that was the obvious choice: the push
  // notification for this same turn already carries 140 characters of it, so a
  // second copy on the same Lock Screen is the same sentence twice. What is NOT
  // anywhere else is how long you waited — and the widget's own timer stops
  // being drawn here, so it has to be baked into the text.
  const secs = Math.round(ranForMs / 1000);
  return secs > 0 ? `回合结束 · 用时 ${shortDuration(secs)}` : '回合结束';
}

export function useLiveActivity(i: LiveActivityInput) {
  // What the shell last accepted, so an unchanged turn costs nothing.
  const sentRef = useRef<{ sessionId: string; sig: string } | null>(null);
  // When the current phase began. Not derived from any server timestamp on
  // purpose: this is what the widget's timer counts from, and a clock the
  // gateway owns would jump if its snapshot arrived late.
  const phaseRef = useRef<{ phase: LiveActivityPhase; sinceMs: number } | null>(null);
  // State, not a ref: the shell answers asynchronously after the page loads, and
  // a device whose owner switches activities back on in Settings has to start
  // working without a reload. A ref would hold the answer and never re-run this.
  const [support, setSupport] = useState(getLiveActivitySupport);
  useEffect(() => onLiveActivitySupport(setSupport), []);

  const { sessionId, agentName, statusKey, activityLabel, activityDetail, title: rawTitle, queued, contextTokens, contextWindow } = i;

  useEffect(() => {
    if (!isNativeShell() || !sessionId || !agentName) return;
    if (support && !support.enabled) return; // switched off in Settings — stay quiet

    const phase = phaseOf(statusKey);
    // How long the phase we are LEAVING lasted. Read before the stamp below
    // moves, and zero when there was nothing running.
    const ranForMs = phaseRef.current && phaseRef.current.phase !== phase
      ? Date.now() - phaseRef.current.sinceMs
      : 0;
    const line = lineFor(phase, { activityLabel, activityDetail }, ranForMs);
    const title = (rawTitle ?? '').trim() || '未命名会话';

    // A phase change restarts the clock: "blocked for 4 minutes" and "working
    // for 4 minutes" are different facts and neither should inherit the other's
    // start.
    if (phaseRef.current?.phase !== phase) {
      phaseRef.current = { phase, sinceMs: Date.now() };
    }
    // Rounded here, once, and the rounded value is what goes in the signature —
    // the raw count moves every few seconds and each move would cost a push.
    const ctx = contextTokens == null ? undefined : Math.round(ctxPct(contextTokens, contextWindow));
    const state: LiveActivityState = {
      phase,
      title,
      line,
      sinceMs: phaseRef.current.sinceMs,
      queued: queued || undefined,
      ctxPct: ctx,
    };

    // Everything a person would see. Deliberately no timestamp and no elapsed.
    const sig = `${phase}|${title}|${line}|${queued}|${ctx ?? '-'}`;
    const sent = sentRef.current;

    if (phase === 'done') {
      // Nothing was up — do not raise one just to end it. That is the ordinary
      // case: every session that is merely sitting there passes through here.
      if (!sent || sent.sessionId !== sessionId) return;
      liveActivityEnd(sessionId, state);
      sentRef.current = null;
      return;
    }

    if (!sent || sent.sessionId !== sessionId) {
      liveActivityStart({
        sessionId,
        agentName,
        // Only worth showing when the device drives more than one deployment;
        // otherwise it is a constant, and a constant on a Lock Screen is noise.
        machineName: machineLabel(),
        state,
      });
      sentRef.current = { sessionId, sig };
      return;
    }
    if (sent.sig !== sig) {
      liveActivityUpdate(sessionId, state);
      sentRef.current = { sessionId, sig };
    }
  }, [sessionId, agentName, statusKey, activityLabel, activityDetail, rawTitle, queued, contextTokens, contextWindow, support]);

  // Leaving the session takes its activity down. The server would keep updating
  // an activity whose turn is still running, which is correct — but this pane is
  // no longer the thing that raised it, and the next pane must be free to raise
  // its own.
  useEffect(() => {
    return () => {
      const sent = sentRef.current;
      if (sent && isNativeShell()) liveActivityEnd(sent.sessionId);
      sentRef.current = null;
      phaseRef.current = null;
    };
  }, [sessionId]);
}

/**
 * The workspace's name — but only when this device drives more than one.
 *
 * With a single machine in the ring the answer is a constant, and a constant on
 * a Lock Screen is a word you read once and then have to keep skipping past.
 */
function machineLabel(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  if (getKeyring().filter((e) => !e.scoped).length < 2) return undefined;
  const e = getActiveEntry();
  return e?.alias || e?.name || undefined;
}
