// alerts router — the machine-health banner's data source. Both procedures are
// machineProcedure (owner-only) and scoped to the caller's active machine,
// matching the rest of the dashboard's per-machine views.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { listOpen, dismiss } from '../machine-alerts';

export const alertsRouter = router({
  // Open alerts for this machine (newest first, max 20). The banner polls this.
  open: machineProcedure.query(async ({ ctx }) => {
    return listOpen(ctx.machine.id);
  }),

  // The human closed one by hand — stamps resolvedAt.
  dismiss: machineProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await dismiss(ctx.machine.id, input.id);
      return { ok: true };
    }),
});
