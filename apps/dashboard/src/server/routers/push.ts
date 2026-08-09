// push router — the device registry, for all three transports.
//
// Originally APNs-only, for the native iOS shell (apps/ios). It now also takes
// Web Push subscriptions from the installed PWA and Bark device keys — the two
// ways to get notifications onto an iPhone with no app to develop and no paid
// Apple Developer account. See docs/no-app-push-design.md.
//
// Everything registers the same way and for the same reason: the CLIENT holds the
// keyring, so it subscribes itself once per machine key through the normal
// authenticated tRPC path. A phone carrying three machine keys ends up with three
// rows and receives pushes from all three machines. No transport needs a
// credential handled outside this file.
//
// machineProcedure throughout: a scoped agent-share key can't subscribe a device
// (it would receive the machine's whole notification stream, well outside the one
// agent it was granted). See docs/ios-shell-design.md.

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { configuredPlatforms, type Platform } from '../push/transport';
import { publicKey as vapidPublicKey } from '../push/webpush';
import { DEFAULT_BARK_SERVER, parseBarkTarget } from '../push/bark';
import { enqueuePush } from '../push';

// APNs tokens are 32 bytes today and 100+ has been signalled for the future; accept
// a generous hex range rather than pinning a length Apple may change.
const DeviceToken = z
  .string()
  .regex(/^[0-9a-f]{32,200}$/i, 'device token must be hex')
  .transform((t) => t.toLowerCase());

// Bark registration input is deliberately permissive here and parsed properly in
// parseBarkTarget — the field accepts the whole URL the Bark app hands you as well
// as a bare key. Validating with a zod regex at this layer was the original
// mistake: it rejected the URL form (i.e. the normal one) and surfaced a wall of
// zod JSON instead of a sentence telling anyone what to do about it.
const BarkInput = z.string().min(1).max(2000);

/**
 * Base URL of a self-hosted bark-server. Free-form by necessity (it is the user's
 * own host); parseBarkTarget only enforces that it is a well-formed http(s) origin.
 * That is not an SSRF guard and isn't meant as one: reaching this procedure already
 * requires a machine key, whose holder can make the machine do considerably more
 * than issue one POST.
 */

// A W3C PushSubscription, as `subscription.toJSON()` hands it over. p256dh is the
// 65-byte uncompressed P-256 point and auth the 16-byte secret, both base64url —
// checked by decoded length rather than string length so padding style can't matter.
const b64urlBytes = (n: number) => (s: string) => Buffer.from(s, 'base64url').length === n;
const WebSubscription = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().refine(b64urlBytes(65), 'p256dh must decode to 65 bytes'),
    auth: z.string().refine(b64urlBytes(16), 'auth must decode to 16 bytes'),
  }),
});

/**
 * A non-reversible label for a device, safe to render in the UI. For web the push
 * service's host is both harmless and the most informative thing available
 * ("web.push.apple.com" says iPhone); for the other two, the last few characters
 * are enough to match a row against the key shown on the phone.
 */
function hint(platform: string, token: string): string {
  if (platform === 'web') {
    try {
      return new URL(token).host;
    } catch {
      return 'unknown endpoint';
    }
  }
  return `…${token.slice(-6)}`;
}

export const pushRouter = router({
  // Subscribe this device to the authenticated machine. Idempotent: the app
  // re-registers on every launch (tokens rotate on reinstall / restore), and the
  // unique (token, machineId) pair turns that into an upsert that just refreshes
  // lastSeenAt.
  register: machineProcedure
    .input(
      z.object({
        token: DeviceToken,
        // Which APNs host this token is valid against — the app reads it from its
        // embedded provisioning profile, since it is not inferable server-side.
        apnsEnv: z.enum(['sandbox', 'production']).default('sandbox'),
        platform: z.literal('ios').default('ios'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await prisma.pushDevice.upsert({
        where: { token_machineId: { token: input.token, machineId: ctx.machine.id } },
        create: {
          token: input.token,
          machineId: ctx.machine.id,
          apnsEnv: input.apnsEnv,
          platform: input.platform,
        },
        // lastSeenAt is @updatedAt; apnsEnv can legitimately change when the same
        // phone moves from an Xcode build to TestFlight.
        update: { apnsEnv: input.apnsEnv, platform: input.platform },
      });
      return { ok: true, configured: configuredPlatforms().includes('ios') };
    }),

  // Subscribe the installed PWA. The endpoint doubles as the row's `token` because
  // it is precisely what identifies a subscription — re-subscribing after the
  // browser rotates keys yields a new endpoint, hence a new row, and the old one is
  // reaped on its next 410.
  registerWeb: machineProcedure
    .input(z.object({ subscription: WebSubscription }))
    .mutation(async ({ ctx, input }) => {
      const { endpoint } = input.subscription;
      await prisma.pushDevice.upsert({
        where: { token_machineId: { token: endpoint, machineId: ctx.machine.id } },
        create: {
          token: endpoint,
          machineId: ctx.machine.id,
          platform: 'web',
          subscription: input.subscription,
        },
        // The auth/p256dh pair can be re-minted for the same endpoint, so always
        // overwrite rather than assuming the stored copy is still current.
        update: { platform: 'web', subscription: input.subscription },
      });
      return { ok: true, configured: configuredPlatforms().includes('web') };
    }),

  // Subscribe a Bark device key. No credential of ours is involved — the key IS
  // the credential, which is why this transport needs no server-side setup at all.
  registerBark: machineProcedure
    .input(z.object({ deviceKey: BarkInput, server: z.string().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const target = parseBarkTarget(input.deviceKey, input.server);
      if (!target.ok) {
        // A sentence someone can act on, not a validation dump. Getting this wrong
        // is indistinguishable from "push is broken" to the person holding a phone.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            target.reason === 'bad-server'
              ? '自建服务器要填完整地址，例如 https://bark.example.com'
              : '认不出这是 Bark 的 device key。直接粘 Bark app 里那一整条 URL 就行（https://api.day.app/xxxxx/…），也可以只填中间 key 那一段。',
        });
      }

      await prisma.pushDevice.upsert({
        where: { token_machineId: { token: target.deviceKey, machineId: ctx.machine.id } },
        create: {
          token: target.deviceKey,
          machineId: ctx.machine.id,
          platform: 'bark',
          barkServer: target.server,
        },
        update: { platform: 'bark', barkServer: target.server },
      });
      return {
        ok: true,
        server: target.server ?? DEFAULT_BARK_SERVER,
        // Echoed back so the UI can prove WHICH key landed — the whole failure
        // this replaces was a registration the user believed had happened.
        hint: hint('bark', target.deviceKey),
        machine: ctx.machine.alias || ctx.machine.name,
      };
    }),

  // Unsubscribe (notifications turned off in iOS Settings, the PWA deleted, or
  // signing a machine out of the keyring). Keyed on the token alone so one call
  // works for every platform.
  unregister: machineProcedure
    .input(z.object({ token: z.string().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const { count } = await prisma.pushDevice.deleteMany({
        where: { token: input.token, machineId: ctx.machine.id },
      });
      return { ok: true, removed: count };
    }),

  // What can this machine actually do? Splits the two failure modes that look
  // identical from a phone: "no device registered" vs "the server has no
  // credentials for that transport". Bark reports configured unconditionally —
  // it has no server-side secret to be missing.
  status: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.pushDevice.groupBy({
      by: ['platform'],
      where: { machineId: ctx.machine.id },
      _count: { _all: true },
    });
    const devices = Object.fromEntries(rows.map((r) => [r.platform, r._count._all])) as Partial<
      Record<Platform, number>
    >;
    return {
      configured: configuredPlatforms(),
      devices,
      total: rows.reduce((n, r) => n + r._count._all, 0),
      // Needed by the browser to call pushManager.subscribe; null when the server
      // has no VAPID keypair, which is the whole "web push unavailable" signal.
      vapidPublicKey: vapidPublicKey(),
      defaultBarkServer: DEFAULT_BARK_SERVER,
    };
  }),

  // The machine's registered devices, for the settings screen.
  //
  // Tokens are NOT returned. Every one of them is a live capability — a Bark key
  // lets its holder push to that phone, an APNs token identifies a device to
  // Apple — and a settings list only needs enough to tell two phones apart. So
  // each row carries a hint instead: the push service's host for web, a short
  // tail for the other two.
  list: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.pushDevice.findMany({
      where: { machineId: ctx.machine.id },
      select: {
        id: true,
        platform: true,
        token: true,
        barkServer: true,
        apnsEnv: true,
        createdAt: true,
        lastSeenAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ token, ...r }) => ({ ...r, hint: hint(r.platform, token) }));
  }),

  // Forget one device from the settings list. Scoped by machineId as well as id,
  // so a key for machine A can never delete machine B's registration.
  remove: machineProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { count } = await prisma.pushDevice.deleteMany({
        where: { id: input.id, machineId: ctx.machine.id },
      });
      return { ok: count > 0 };
    }),

  // Send a test notification to every device on this machine. `host` kind so it
  // goes out urgent and a Focus mode won't swallow it — a test you can't tell
  // apart from a failure is not a test. Verifying end-to-end delivery needs a
  // real device; this is the button.
  test: machineProcedure.mutation(async ({ ctx }) => {
    const devices = await prisma.pushDevice.count({ where: { machineId: ctx.machine.id } });
    if (devices === 0) return { ok: false, reason: 'no devices registered' as const };
    enqueuePush({
      kind: 'host',
      machineId: ctx.machine.id,
      title: 'Hermit',
      body: `Test notification from ${ctx.machine.alias || ctx.machine.name}`,
      path: '/',
      collapseKey: `test-${ctx.machine.id}`,
    });
    return { ok: true, devices };
  }),
});
