// Builders that turn a gateway write into a PushEvent. Kept out of the /api/sync
// routes so those stay about persistence and each trigger point is a single line.
//
// Wording note: the notification title is what shows in bold on the lock screen,
// so it carries the AGENT (or cron / machine) name — that's the part you scan for.
// The body carries the actual content.

import { fmtGB } from '@/lib/host-health';
import type { PushEvent } from './types';

const PREVIEW_LEN = 140;

/**
 * First text block of an Anthropic content array, flattened to one line. Returns
 * null for a turn that is pure tool traffic — nothing a human would want pushed.
 * (Mirrors firstText() in routers/notifications.ts, which reads the same column.)
 */
export function previewText(content: unknown): string | null {
  if (typeof content === 'string') {
    const s = content.replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, PREVIEW_LEN) : null;
  }
  if (!Array.isArray(content)) return null;
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
    }
  }
  return null;
}

/** An agent replied. Null when the message carries no human-readable text. */
export function chatEvent(args: {
  machineId: string;
  sessionId: string;
  agentName: string;
  content: unknown;
}): PushEvent | null {
  const body = previewText(args.content);
  if (!body) return null;
  return {
    kind: 'chat',
    machineId: args.machineId,
    title: args.agentName,
    body,
    path: `/chat?session=${args.sessionId}`,
    // Per session: a busy turn replaces its own notification instead of stacking.
    collapseKey: args.sessionId,
    sessionId: args.sessionId,
  };
}

/**
 * A scheduled task SUCCEEDED and its report was posted into a chat session.
 *
 * The failure case is cronEvent below, which points at /cron. This one points at
 * the conversation, because a cron that reports into a chat is the thing that
 * replaced the session-scoped loop: you asked for it in a conversation and you
 * read the rounds there.
 *
 * Separate from chatEvent for two reasons, both about the hold in ./index.ts:
 *
 *   - it is NOT held. The report IS the conclusion of the run — there is no turn
 *     left to wait for. Held, a report on a session with a long-running
 *     background task waits out BACKGROUND_HOLD_MAX_MS and is then delivered
 *     carrying whatever the agent said in the meantime, which is how 13 hourly
 *     rounds produced 4 late notifications, none of them a round report
 *     (2026-08-24, back when this was the loop).
 *   - it has its OWN collapse key. Sharing the session's key would let ordinary
 *     chatter — "let me check that", a stale task notification — replace the
 *     report on the lock screen. A report is the thing you asked for; it gets
 *     its own slot.
 */
export function cronReportEvent(args: {
  machineId: string;
  sessionId: string;
  agentName: string;
  /** The cron's title, or the agent name when it has none. */
  cronName: string;
  /** The run's output; only its first non-empty line reaches the lock screen. */
  output: string;
}): PushEvent {
  const firstLine = args.output.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return {
    kind: 'cron',
    machineId: args.machineId,
    title: `${args.agentName} · ${args.cronName}`,
    body: firstLine.slice(0, PREVIEW_LEN),
    path: `/chat?session=${args.sessionId}`,
    collapseKey: `${args.sessionId}:cron`,
    sessionId: args.sessionId,
  };
}

/** An agent is stopped, waiting for a permission or question decision. */
export function blockedEvent(args: {
  machineId: string;
  sessionId: string;
  agentName: string;
  kind: 'permission' | 'question';
  payload: unknown;
}): PushEvent {
  const p = (args.payload ?? {}) as { tool?: string; question?: string };
  const body =
    args.kind === 'permission'
      ? `Wants to run ${p.tool || 'a tool'} — approve?`
      : (p.question || 'Needs your answer').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
  return {
    kind: 'blocked',
    machineId: args.machineId,
    title: `${args.agentName} is waiting`,
    body,
    // Same collapse key as chatEvent on purpose: "is waiting" supersedes "replied"
    // for the same session rather than sitting next to it.
    path: `/chat?session=${args.sessionId}`,
    collapseKey: args.sessionId,
    sessionId: args.sessionId,
  };
}

/** A scheduled task ended badly. Callers filter on status before building this. */
export function cronEvent(args: {
  machineId: string;
  cronId: string;
  runId: string | null;
  cronName: string;
  status: string;
}): PushEvent {
  const label =
    args.status === 'timeout'
      ? 'timed out'
      : args.status === 'no_output'
        ? 'produced no output'
        : 'failed';
  return {
    kind: 'cron',
    machineId: args.machineId,
    title: 'Scheduled task',
    body: `${args.cronName} ${label}`,
    // Same shape the notifications inbox opens (id + run auto-expands that run).
    path: args.runId
      ? `/cron?id=${encodeURIComponent(args.cronId)}&run=${encodeURIComponent(args.runId)}`
      : `/cron?id=${encodeURIComponent(args.cronId)}`,
    collapseKey: `cron-${args.cronId}`,
  };
}

/**
 * The human asked something and nothing answered it. See server/unanswered.ts.
 *
 * The body leads with their own words, because the question is what tells them
 * instantly whether this matters — `查看为什么线上挂了` reads very differently from
 * `顺便看看那个 typo`. Runtime state trails it as triage, and is deliberately NOT part
 * of the decision to send.
 */
export function unansweredEvent(args: {
  machineId: string;
  sessionId: string;
  agentName: string;
  content: unknown;
  waitedMinutes: number;
  state: string;
}): PushEvent {
  const asked = previewText(args.content);
  const quoted = asked ? `“${asked.slice(0, 90)}” · ` : '';
  return {
    kind: 'stall',
    machineId: args.machineId,
    title: `${args.agentName} never answered`,
    body: `${quoted}${args.waitedMinutes} min, no reply · ${args.state}`,
    path: `/chat?session=${args.sessionId}`,
    // Same key as chatEvent / blockedEvent: one session, one lock-screen slot.
    collapseKey: args.sessionId,
    sessionId: args.sessionId,
  };
}

/**
 * The unanswered check itself is failing. A monitor that goes quiet is
 * indistinguishable from a monitor with nothing to report, so its own breakage is
 * an alert rather than a log line nobody reads.
 */
export function unansweredFailureEvent(args: {
  machineId: string;
  message: string;
  failures: number;
}): PushEvent {
  return {
    kind: 'stall',
    machineId: args.machineId,
    title: 'Unanswered-check is failing',
    body: `${args.failures}x in a row · ${args.message.slice(0, 100)}`,
    path: '/system',
    collapseKey: `unanswered-failure-${args.machineId}`,
  };
}

/** A machine crossed into red resource pressure. */
export function hostEvent(args: {
  machineId: string;
  machineName: string;
  ramFreeMb?: number | null;
  loadAvg1?: number | null;
}): PushEvent {
  return {
    kind: 'host',
    machineId: args.machineId,
    title: `${args.machineName} under pressure`,
    body: `free ${fmtGB(args.ramFreeMb)} GB · load ${args.loadAvg1?.toFixed(1) ?? '—'}`,
    path: '/system',
    collapseKey: `host-${args.machineId}`,
  };
}
