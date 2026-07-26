// push router — APNs device registry for the native iOS shell (apps/ios).
//
// The shell deliberately holds no machine key. It hands its APNs device token to
// the web layer, which calls `register` once per keyring entry through the normal
// authenticated tRPC client — so a phone carrying three machine keys ends up with
// three rows and receives pushes from all three machines. Auth is therefore the
// existing one, with no native-side credential handling to get wrong.
//
// machineProcedure throughout: a scoped agent-share key can't subscribe a device
// (it would receive the machine's whole notification stream, well outside the one
// agent it was granted). See docs/ios-shell-design.md.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { isConfigured } from '../push/apns';
import { enqueuePush } from '../push';

// APNs tokens are 32 bytes today and 100+ has been signalled for the future; accept
// a generous hex range rather than pinning a length Apple may change.
const DeviceToken = z
  .string()
  .regex(/^[0-9a-f]{32,200}$/i, 'device token must be hex')
  .transform((t) => t.toLowerCase());

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
      return { ok: true, configured: isConfigured() };
    }),

  // Unsubscribe (notifications turned off in iOS Settings, or signing a machine
  // out of the keyring).
  unregister: machineProcedure
    .input(z.object({ token: DeviceToken }))
    .mutation(async ({ ctx, input }) => {
      await prisma.pushDevice.deleteMany({
        where: { token: input.token, machineId: ctx.machine.id },
      });
      return { ok: true };
    }),

  // Is push wired up at all, and does this machine have any device? Lets the app
  // (and a future settings row) tell "no devices" apart from "server has no APNs
  // credentials", which otherwise look identical from the outside.
  status: machineProcedure.query(async ({ ctx }) => {
    const devices = await prisma.pushDevice.count({ where: { machineId: ctx.machine.id } });
    return { configured: isConfigured(), devices };
  }),

  // Send a test notification to every device on this machine. `host` kind so it
  // ignores quiet hours — a test you have to wait until morning to receive is not
  // a test. Verifying end-to-end delivery needs a real device; this is the button.
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
