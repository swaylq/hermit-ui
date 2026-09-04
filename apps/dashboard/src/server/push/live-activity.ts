// Keeping the Lock Screen / Dynamic Island honest while the phone is locked.
//
// The app raises the activity (it is the only side that knows a turn began) and
// hands over an APNs token; from then on this file owns what it says. That split
// is the entire reason the feature is worth building — an activity only its own
// app can update freezes the moment you put the phone down, which is exactly
// when a lock-screen widget is supposed to be useful.
//
// Three rules, each of which the existing push path learned the hard way:
//
//  · **Not through `enqueuePush`.** That pipeline's 20-second debounce and
//    `turnStillRunning` gate exist to avoid interrupting you mid-turn (see
//    push/index.ts). A Live Activity wants precisely the mid-turn states, so it
//    hangs off the snapshot write instead and shares none of that machinery.
//  · **Never send elapsed time.** The widget draws its own timer from one start
//    stamp and the system ticks it for free. Putting a duration in the payload
//    would mean a push every snapshot — Apple budgets high-frequency activity
//    updates and starts dropping them. `session-state-push.ts` excludes
//    `elapsedSec` from its signature for the same reason.
//  · **Only on change.** The gateway writes a snapshot every 8 seconds and the
//    turn-boundary channel adds more. Almost all of them say the same thing.

import { prisma } from '@/server/db';
import { sendLiveActivity, isDeadToken, type ApnsEnv } from './apns';
import { backgroundOutstanding } from '@/lib/session-status';
import { contextWindowFor } from '@/lib/context-window';
import { ctxPct } from '@/lib/format';
import { PREVIEW_KEYS } from '@/server/message-digest';
import { USER_QUEUE_FILTER } from '@/lib/chat-queue';

/// What the widget decodes. Field-for-field with
/// apps/ios/Shared/SessionActivityAttributes.swift — a name that does not match
/// makes the whole update vanish with a 200 from APNs and nothing in any log.
interface ContentState extends Record<string, unknown> {
  phase: 'working' | 'blocked' | 'done' | 'failed';
  title: string;
  line: string;
  /** Unix SECONDS. Spelled out rather than left to a date encoder — see the
   *  comment on `sinceEpoch` in the Swift file. */
  sinceEpoch: number;
  queued?: number;
  /** Context window fullness, 0-100, rounded. Undefined until a turn completes.
   *  Rounded on purpose: the raw token count moves every few seconds and the
   *  signature below would turn every move into an APNs push. */
  ctxPct?: number;
}

/** The widget truncates too, but a payload over 4KB is dropped silently, so the
 *  cut happens before it is ever sent. */
const MAX_LINE = 120;

/** Floor between two updates for the same session. A blocked turn and an ending
 *  one skip it: those are the two a person is actually waiting on, and the next
 *  snapshot could be eight seconds away. */
const MIN_INTERVAL_MS = 2_000;
const lastSentAt = new Map<string, number>();

/** After this with no update the system dims the activity as possibly stale.
 *  Generous because a long tool call legitimately produces no change at all —
 *  the point is to catch a gateway that died, not a Bash that is thinking. */
const WORKING_STALE_MS = 15 * 60_000;
/** A blocked turn is a static fact that can hold for hours. Dimming it would be
 *  lying about something still true. */
const BLOCKED_STALE_MS = 6 * 60 * 60_000;
/** How long a finished activity stays up. The ordinary push notification already
 *  delivered the result, so this is a second chance to notice, not the only one. */
const LINGER_MS = 5 * 60_000;

type Phase = ContentState['phase'];

/**
 * The one line worth reading, built WITHOUT any elapsed time.
 *
 * Deliberately not `activityLabel()` from lib/session-status, which folds the
 * duration into the string ("Bash · 47s +2 bg") — correct for a header that
 * re-renders for free, fatal for something that costs an APNs push per change.
 */
/**
 * What a blocked turn is actually asking, in one line.
 *
 * "等你回答" says the state, which the colour, the raised hand and the button all
 * say already. What nothing else on that Lock Screen can say is WHICH decision —
 * whether this is worth reaching for the phone or can wait for the desk.
 *
 * Shapes come from api/sync/interaction: `permission` carries `{tool, input}`,
 * `question` carries `{question}`. The argument is picked with the same key
 * order the collapsed tool chip uses, so the island and the card in the
 * timeline name the same thing.
 */
function blockedLine(kind: string, payload: unknown): string {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  if (kind === 'question') {
    const q = typeof p.question === 'string' ? p.question.replace(/\s+/g, ' ').trim() : '';
    return q || '等你回答';
  }
  const tool = typeof p.tool === 'string' && p.tool ? p.tool : 'tool';
  const input = p.input && typeof p.input === 'object' && !Array.isArray(p.input)
    ? (p.input as Record<string, unknown>)
    : {};
  let arg = '';
  for (const k of PREVIEW_KEYS) {
    if (typeof input[k] === 'string' && input[k]) { arg = (input[k] as string).replace(/\s+/g, ' ').trim(); break; }
  }
  return arg ? `要用 ${tool}：${arg}` : `要用 ${tool}`;
}

function lineFor(phase: Phase, activity: unknown, agentName: string): string {
  if (phase === 'blocked') return '等你回答';
  if (phase !== 'working') return '回合结束';
  const a = activity && typeof activity === 'object' && !Array.isArray(activity)
    ? (activity as Record<string, unknown>)
    : null;
  const label = typeof a?.label === 'string' && a.label ? a.label : null;
  const detail = typeof a?.detail === 'string' && a.detail ? a.detail : null;
  if (label && detail) return `${label} · ${detail}`;
  return label ?? detail ?? `${agentName} 正在处理`;
}

function phaseOf(state: string | null, blocked: boolean, activity: unknown): Phase {
  if (blocked) return 'blocked';
  if (state === 'working' || state === 'starting') return 'working';
  // `state: 'idle'` alone does not mean the work is over — a backgrounded Bash
  // or subagent ends the turn within a millisecond of being launched. The same
  // judgement push/suppress.ts uses.
  if (backgroundOutstanding(activity)) return 'working';
  return 'done';
}

/** Everything a person would see. No timestamps, no durations. */
function signature(s: ContentState): string {
  return `${s.phase}|${s.title}|${s.line}|${s.queued ?? 0}|${s.ctxPct ?? '-'}`;
}

/**
 * Bring every activity for this session up to date. Safe to call on every
 * snapshot write: it returns immediately when the session has no activity, which
 * is the overwhelmingly common case.
 */
export async function syncSessionActivity(sessionId: string): Promise<void> {
  const rows = await prisma.liveActivity.findMany({ where: { sessionId } });
  if (rows.length === 0) return;

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      title: true, agentName: true, state: true, activity: true, closedAt: true,
      // For the context readout. `runtime`/`runtimeModel` decide the window size
      // — a codex or kimi session does not have claude's, and showing 12% of the
      // wrong denominator is worse than showing nothing.
      contextTokens: true, runtime: true, runtimeModel: true,
    },
  });
  if (!session) {
    await endActivities(rows, { phase: 'done', title: '', line: '会话已删除', sinceEpoch: nowSec() });
    return;
  }

  const [pending, queued] = await Promise.all([
    // The newest, not a count: a blocked turn's line is the decision it is
    // waiting on, and that has to be read off the row itself.
    prisma.interaction.findFirst({
      where: { sessionId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { kind: true, payload: true },
    }),
    // USER_QUEUE_FILTER, not a hand-written where. A bare role+deliveredAt also
    // matches every row the gateway synced from the transcript — the agent's own
    // tool_results are role 'user' in Anthropic's format — which is how this
    // first shipped showing "排队 511" on a Lock Screen.
    prisma.chatMessage.count({ where: { sessionId, ...USER_QUEUE_FILTER } }),
  ]);

  const phase: Phase = session.closedAt ? 'done' : phaseOf(session.state, pending != null, session.activity);
  const line =
    phase === 'blocked' && pending
      ? blockedLine(pending.kind, pending.payload)
      : lineFor(phase, session.activity, session.agentName ?? 'agent');
  const ctx =
    session.contextTokens == null
      ? undefined
      : Math.round(ctxPct(session.contextTokens, contextWindowFor(session.runtime, session.runtimeModel)));

  for (const row of rows) {
    // The start stamp moves only when the phase does — the widget's timer counts
    // from it, so re-sending `now` on every tool change would reset it on screen
    // once a minute.
    const phaseChanged = row.phase !== phase;
    const since = phaseChanged || !row.phaseSince ? new Date() : row.phaseSince;
    const state: ContentState = {
      phase,
      title: (session.title ?? '').slice(0, MAX_LINE) || '未命名会话',
      line: line.slice(0, MAX_LINE),
      sinceEpoch: Math.floor(since.getTime() / 1000),
      ...(queued > 0 ? { queued } : {}),
      ...(ctx === undefined ? {} : { ctxPct: ctx }),
    };
    const sig = signature(state);
    if (row.lastSig === sig) continue;

    // Rate floor, waived for the two transitions someone is waiting on.
    const urgent = phase === 'blocked' || phase === 'done';
    const last = lastSentAt.get(row.id) ?? 0;
    if (!urgent && Date.now() - last < MIN_INTERVAL_MS) continue;

    if (phase === 'done') {
      await endOne(row, state);
      continue;
    }

    lastSentAt.set(row.id, Date.now());
    const result = await sendLiveActivity(row.token, row.apnsEnv as ApnsEnv, {
      event: 'update',
      contentState: state,
      staleDate: new Date(Date.now() + (phase === 'blocked' ? BLOCKED_STALE_MS : WORKING_STALE_MS)),
      // A block is the one transition worth waking someone for; a tool change is
      // not, and at priority 10 every one of them would spend budget that Apple
      // eventually stops honouring.
      priority: phase === 'blocked' ? 10 : 5,
      relevanceScore: phase === 'blocked' ? 100 : 50,
      ...(phaseChanged && phase === 'blocked'
        ? { alert: { title: `${session.agentName ?? 'agent'} 在等你`, body: state.title } }
        : {}),
    });

    if (result.status === 200) {
      await prisma.liveActivity
        .update({
          where: { id: row.id },
          data: {
            lastSig: sig,
            phase,
            phaseSince: since,
            ...(result.envUsed ? { apnsEnv: result.envUsed } : {}),
          },
        })
        .catch(() => undefined);
    } else if (isDeadToken(result)) {
      // Also how a user swiping the activity away is discovered: the token stops
      // being addressable and there is no other signal.
      await prisma.liveActivity.delete({ where: { id: row.id } }).catch(() => undefined);
      lastSentAt.delete(row.id);
    }
  }
}

/** Take every activity for a session down now. */
export async function endSessionActivities(sessionId: string, line: string): Promise<void> {
  const rows = await prisma.liveActivity.findMany({ where: { sessionId } });
  if (rows.length === 0) return;
  await endActivities(rows, { phase: 'done', title: '', line, sinceEpoch: nowSec() });
}

type Row = { id: string; token: string; apnsEnv: string };

async function endActivities(rows: Row[], state: ContentState): Promise<void> {
  for (const row of rows) await endOne(row, state);
}

async function endOne(row: Row, state: ContentState): Promise<void> {
  await sendLiveActivity(row.token, row.apnsEnv as ApnsEnv, {
    event: 'end',
    contentState: state,
    dismissalDate: new Date(Date.now() + LINGER_MS),
    priority: 10,
  });
  // The row goes whether or not APNs took it: the activity is over either way,
  // and a row that survives would keep this session on the "has an activity"
  // fast path forever.
  await prisma.liveActivity.delete({ where: { id: row.id } }).catch(() => undefined);
  lastSentAt.delete(row.id);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
