// Secrets — the active machine's encrypted store (~/.claude/global-memory/
// secrets.age), surfaced for the dashboard's Secrets view. Every op is forwarded
// LIVE to that machine's gateway over the control-channel bridge (requestSecrets
// → secrets.req/secrets.res); the gateway decrypts via the local `secret` CLI
// because the age master key lives in ITS Keychain, not on the VPS.
//
// `reveal` is a mutation (not a query): it has a side effect (the gateway audits
// the read) and must never be cached/refetched — a value is fetched only on an
// explicit click and held briefly in the browser.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { requestSecrets } from '../gateway-bridge';

const KEY = z.string().regex(/^[A-Za-z0-9_]+$/, 'key must be A-Za-z0-9_');

export const secretsRouter = router({
  list: machineProcedure.query(async ({ ctx }) => {
    const res = await requestSecrets(ctx.machine.id, 'list');
    if (!res.ok) throw new Error(res.error);
    return res.data as { keys: string[] };
  }),

  reveal: machineProcedure.input(z.object({ key: KEY })).mutation(async ({ ctx, input }) => {
    const res = await requestSecrets(ctx.machine.id, 'reveal', { key: input.key });
    if (!res.ok) throw new Error(res.error);
    return res.data as { value: string };
  }),

  set: machineProcedure
    .input(z.object({ key: KEY, value: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const res = await requestSecrets(ctx.machine.id, 'set', { key: input.key, value: input.value });
      if (!res.ok) throw new Error(res.error);
      return { ok: true };
    }),

  remove: machineProcedure.input(z.object({ key: KEY })).mutation(async ({ ctx, input }) => {
    const res = await requestSecrets(ctx.machine.id, 'rm', { key: input.key });
    if (!res.ok) throw new Error(res.error);
    return { ok: true };
  }),
});
