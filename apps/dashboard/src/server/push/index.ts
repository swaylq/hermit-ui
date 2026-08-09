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
// Chat events are DEBOUNCED. One agent turn writes many ChatMessage rows (text
// block, tool_use, tool_result, more text…), and pushing each would fire a dozen
// notifications for a single reply. A trailing 20 s debounce per session collapses
// the turn into exactly one push carrying the LAST thing the agent said — which is
// also the part worth reading. The other three kinds are discrete events and go
// out immediately.
//
// State (debounce timers) is process-local. That's sound here: the dashboard runs
// as a single pm2 fork (`ecosystem.config.cjs` — no `instances`/cluster), and the
// worst case on restart is one duplicate notification.

import { prisma } from '@/server/db';
import { shouldPush, isUrgentKind } from './suppress';
import { anyTransportConfigured, transportFor } from './transport';
import type { PushEvent } from './types';

export type { PushEvent, PushKind } from './types';

/** Wait this long after an agent's last message before pushing the turn. */
const CHAT_DEBOUNCE_MS = 20_000;

const pending = new Map<string, { timer: NodeJS.Timeout; event: PushEvent }>();

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
    const timer = setTimeout(() => {
      pending.delete(event.collapseKey);
      void deliver(event).catch((e) => console.error('[push] deliver failed', e));
    }, CHAT_DEBOUNCE_MS);
    // Don't keep the process alive just to flush a notification.
    timer.unref?.();
    pending.set(event.collapseKey, { timer, event });
    return;
  }

  void deliver(event).catch((e) => console.error('[push] deliver failed', e));
}

/** Flush any debounced pushes now (tests / graceful shutdown). */
export function flushPending(): void {
  for (const [key, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(key);
    void deliver(p.event).catch(() => {});
  }
}

async function deliver(event: PushEvent): Promise<void> {
  const now = Date.now();

  // Read state at DELIVERY time: during a chat debounce the user may have opened
  // the session, which should cancel the push.
  let lastReadAt: Date | null | undefined;
  if (event.sessionId) {
    const s = await prisma.chatSession.findUnique({
      where: { id: event.sessionId },
      select: { lastReadAt: true },
    });
    lastReadAt = s?.lastReadAt ?? null;
  }

  const decision = shouldPush({ now, lastReadAt });
  if (!decision.send) return;

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
  if (devices.length === 0) return;

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
  const dead: string[] = [];
  await Promise.all(
    devices.map(async (d) => {
      const transport = transportFor(d.platform);
      if (!transport) {
        console.warn(`[push] unknown platform '${d.platform}' on device ${d.id}`);
        return;
      }
      // A transport whose credentials are absent stays quiet rather than logging
      // once per device per event — enqueuePush already warned at startup.
      if (!transport.isConfigured()) return;

      const r = await transport.send(d, payload);
      if (r.dead) dead.push(d.id);
      else if (!r.ok) console.warn(`[push] ${event.kind} → ${d.platform}: ${r.detail ?? 'failed'}`);
    }),
  );

  // A device the transport has disowned (app deleted, subscription revoked, key
  // unknown) will never work again — drop the row rather than retry it forever.
  if (dead.length > 0) {
    await prisma.pushDevice.deleteMany({ where: { id: { in: dead } } });
  }
}
