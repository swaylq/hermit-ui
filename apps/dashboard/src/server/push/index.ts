// Push fan-out: takes an event from a gateway write point and gets it onto the
// phone, or decides not to. See docs/ios-shell-design.md.
//
// WHICH phone, and over which wire, is ./transport.ts's problem — a machine's
// devices can be a mix of the native shell (APNs), the installed PWA (Web Push)
// and Bark, and everything in this file is identical for all three. See
// docs/no-app-push-design.md for why more than one wire is deliberate.
//
// Call site contract: `enqueuePush()` returns void and NEVER throws or awaits
// anything the caller can see. Every trigger point sits inside a /api/sync write
// that must not slow down or fail because a notification didn't go out.
//
// Chat events are HELD UNTIL THE TURN ENDS. One agent turn writes many ChatMessage
// rows (text block, tool_use, tool_result, more text…), and pushing each would fire
// a dozen notifications for a single reply. Two conditions have to hold before one
// goes out: the agent has been quiet for 20 s, AND it is no longer working.
//
// The second half is not redundant. A trailing debounce on its own assumes a turn
// is a burst of messages — true of a two-line answer, false of the work this fleet
// actually does. An agent on a long task says "let me look at X", then sits in a
// tool for two minutes; the 20 s of quiet arrives in the MIDDLE of the turn and the
// preamble goes to the lock screen, then the next one does, and the next. sway,
// 2026-08-21: "agent 要当前任务都结束回复用户了再推送消息，中间过程不用推送".
//
// So the debounce is the floor and `turnStillRunning` is the gate: while the
// session is working the timer re-arms instead of delivering, and the event it is
// holding keeps being replaced by whatever the agent says next — so what finally
// lands is the LAST thing it said, which is the answer. The other three kinds are
// discrete events and go out immediately; `blocked` in particular must, since that
// one means the turn has stopped and is waiting on you.
//
// State (the held events) is process-local. That's sound here: the dashboard runs
// as a single pm2 fork (`ecosystem.config.cjs` — no `instances`/cluster), and the
// worst case on restart is one duplicate notification — or, now that a hold can
// outlive a deploy, one missed one. The message itself is never lost either way:
// it still marks the session unread in the sidebar and in the inbox.

import { prisma } from '@/server/db';
import { shouldPush, isUrgentKind, turnStillRunning } from './suppress';
import { anyTransportConfigured, transportFor } from './transport';
import type { PushEvent } from './types';

export type { PushEvent, PushKind } from './types';

/**
 * Quiet floor: wait this long after an agent's last message before even asking
 * whether the turn is over. Keeps a burst of rows from costing a query each, and
 * is what makes the held event the agent's LAST word rather than its first.
 */
const CHAT_DEBOUNCE_MS = 20_000;

/**
 * How long a hold can run before it is worth a log line.
 *
 * Not a ceiling — the hold continues. It exists so that "I never got a
 * notification for that reply" has somewhere to be looked up, since a session
 * whose `state` never leaves 'working' would otherwise wait silently for ever.
 */
const HOLD_REPORT_MS = 30 * 60_000;

const pending = new Map<
  string,
  { timer: NodeJS.Timeout; event: PushEvent; heldSince: number; reported: boolean }
>();

let warnedUnconfigured = false;

/**
 * Hand an event to the push pipeline. Fire-and-forget by design — see the call
 * site contract above.
 */
export function enqueuePush(event: PushEvent): void {
  if (!anyTransportConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.log('[push] no transport configured — push notifications disabled');
    }
    return;
  }

  if (event.kind === 'chat') {
    const existing = pending.get(event.collapseKey);
    if (existing) clearTimeout(existing.timer);
    // A newer message replaces the held one but does NOT restart the hold clock —
    // that clock only exists for the report line, and it is measuring the turn.
    arm(event, existing?.heldSince ?? Date.now(), existing?.reported ?? false);
    return;
  }

  void deliver(event).catch((e) => console.error('[push] deliver failed', e));
}

/**
 * Park a chat event for CHAT_DEBOUNCE_MS, then either deliver it or park it again
 * because the turn is still going.
 *
 * Re-arming rather than polling on a fixed interval keeps the cost proportional:
 * one primary-key lookup per 20 s per session that is BOTH holding a reply and
 * still working, which is a handful even on a busy machine, and zero for every
 * session that is idle.
 */
function arm(event: PushEvent, heldSince: number, reported: boolean): void {
  const timer = setTimeout(() => {
    void (async () => {
      const session = event.sessionId ? await readSession(event.sessionId) : null;
      if (turnStillRunning({ state: session?.state, snapshotAt: session?.snapshotAt, now: Date.now() })) {
        const held = Date.now() - heldSince;
        const worthReporting = !reported && held >= HOLD_REPORT_MS;
        if (worthReporting) {
          console.warn(
            `[push] chat notification for session ${event.sessionId} held ${Math.round(held / 60_000)} min — still working`,
          );
        }
        arm(event, heldSince, reported || worthReporting);
        return;
      }
      pending.delete(event.collapseKey);
      await deliver(event, session);
    })().catch((e) => console.error('[push] deliver failed', e));
  }, CHAT_DEBOUNCE_MS);
  // Don't keep the process alive just to flush a notification.
  timer.unref?.();
  pending.set(event.collapseKey, { timer, event, heldSince, reported });
}

type SessionState = { lastReadAt: Date | null; state: string | null; snapshotAt: Date | null };

async function readSession(sessionId: string): Promise<SessionState | null> {
  return prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { lastReadAt: true, state: true, snapshotAt: true },
  });
}

/**
 * Flush any held pushes now (tests / graceful shutdown). Deliberately bypasses the
 * turn gate: on the way down, a notification that arrives a little early beats one
 * that dies with the process.
 */
export function flushPending(): void {
  for (const [key, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(key);
    void deliver(p.event).catch(() => {});
  }
}

/** What one device did with one event. Returned by deliverNow for the test button. */
export interface DeliveryResult {
  deviceId: string;
  platform: string;
  ok: boolean;
  /** The row was removed because the transport says this device is gone. */
  reaped: boolean;
  detail?: string;
}

/**
 * Deliver and report. `enqueuePush` throws the result away — nothing on a gateway
 * write path can act on it — but `push.test` awaits it, because a test button that
 * answers before the send has been attempted isn't testing anything.
 */
export async function deliverNow(event: PushEvent): Promise<DeliveryResult[]> {
  return deliver(event);
}

async function deliver(event: PushEvent, known?: SessionState | null): Promise<DeliveryResult[]> {
  const now = Date.now();

  // Read state at DELIVERY time: during a chat hold the user may have opened the
  // session, which should cancel the push. `known` is the row the chat flush has
  // already fetched to answer "is the turn over" — re-reading it here would be a
  // second query for the same row in the same tick.
  let lastReadAt: Date | null | undefined;
  if (known !== undefined) {
    lastReadAt = known?.lastReadAt ?? null;
  } else if (event.sessionId) {
    lastReadAt = (await readSession(event.sessionId))?.lastReadAt ?? null;
  }

  const decision = shouldPush({ now, lastReadAt });
  if (!decision.send) return [];

  const devices = await prisma.pushDevice.findMany({
    where: { machineId: event.machineId },
    select: {
      id: true,
      platform: true,
      token: true,
      apnsEnv: true,
      subscription: true,
      barkServer: true,
    },
  });
  if (devices.length === 0) return [];

  const payload = {
    title: event.title,
    body: event.body,
    path: event.path,
    collapseKey: event.collapseKey,
    kind: event.kind,
    // Marks the push time-sensitive so a Focus mode lets it through. The only
    // timing influence the server has — it never withholds by clock.
    urgent: isUrgentKind(event.kind),
  };

  // One device may be on a different wire than the next; each transport decides
  // for itself whether a failure means "gone" or "try again next time".
  const results: DeliveryResult[] = await Promise.all(
    devices.map(async (d): Promise<DeliveryResult> => {
      const transport = transportFor(d.platform);
      if (!transport) {
        console.warn(`[push] unknown platform '${d.platform}' on device ${d.id}`);
        return { deviceId: d.id, platform: d.platform, ok: false, reaped: false, detail: 'unknown platform' };
      }
      // A transport whose credentials are absent stays quiet rather than logging
      // once per device per event — enqueuePush already warned at startup.
      if (!transport.isConfigured()) {
        return { deviceId: d.id, platform: d.platform, ok: false, reaped: false, detail: 'transport not configured' };
      }

      const r = await transport.send(d, payload);
      if (!r.ok) console.warn(`[push] ${event.kind} → ${d.platform}: ${r.detail ?? 'failed'}${r.dead ? ' (reaping)' : ''}`);
      return { deviceId: d.id, platform: d.platform, ok: r.ok, reaped: r.dead, detail: r.detail };
    }),
  );

  // A device the transport has disowned (app deleted, subscription revoked, key
  // unknown) will never work again — drop the row rather than retry it forever.
  //
  // This is LOGGED, not silent. Deleting someone's registration behind their back
  // is how "I registered and nothing ever arrived" happens: the row vanishes from
  // the settings list and no record anywhere says a send was ever attempted.
  const dead = results.filter((r) => r.reaped).map((r) => r.deviceId);
  if (dead.length > 0) {
    await prisma.pushDevice.deleteMany({ where: { id: { in: dead } } });
    console.warn(`[push] reaped ${dead.length} dead device(s) on machine ${event.machineId}`);
  }

  return results;
}
