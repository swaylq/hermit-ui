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
