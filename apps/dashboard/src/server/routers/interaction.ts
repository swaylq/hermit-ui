// Blocking interactions the WEB user must resolve — the permission-approval and
// AskUserQuestion-style prompts that otherwise render only in the local tmux
// pane (never in the JSONL) and hang the turn. Created by the gateway permission
// hook (kind=permission) and the mcp__hermit__ask tool (kind=question) via
// /api/sync/interaction; the blocked side LONG-POLLS its `status`. The browser
// renders an inline card ({type:'interaction'} ChatMessage block) and calls
// `resolve` on a button click — which flips `status` (unblocking the hook/tool)
// and rewrites the card message so the SSE stream shows the outcome.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

const DecisionInput = z.object({
  // permission
  behavior: z.enum(['allow', 'deny']).optional(),
  reason: z.string().max(2000).optional(),
  // question (free-text "other" answer ⇒ answers:[text])
  answers: z.array(z.string().max(4000)).optional(),
});

export const interactionRouter = router({
  // Pending interactions for a session. The inline card block carries most of
  // the state, but the chat page also polls this to gate the composer.
  listPending: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return prisma.interaction.findMany({
        where: { sessionId: input.sessionId, status: 'pending', session: { machineId: ctx.machine.id } },
        orderBy: { createdAt: 'asc' },
      });
    }),

  byId: machineProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const i = await prisma.interaction.findUnique({
      where: { id: input.id },
      include: { session: { select: { machineId: true } } },
    });
    if (!i || i.session.machineId !== ctx.machine.id) return null;
    const { session: _s, ...rest } = i;
    return rest;
  }),

  // User clicked a button. Write the decision + flip status (idempotent), then
  // rewrite the inline card message so the SSE stream re-renders it as resolved.
  // The blocked hook / ask tool sees status!=pending on its next poll and runs.
  resolve: machineProcedure
    .input(z.object({ id: z.string(), decision: DecisionInput }))
    .mutation(async ({ ctx, input }) => {
      const i = await prisma.interaction.findUnique({
        where: { id: input.id },
        include: { session: { select: { machineId: true } } },
      });
      if (!i || i.session.machineId !== ctx.machine.id) throw new Error('not found');
      if (i.status !== 'pending') return i; // already resolved — idempotent

      const updated = await prisma.interaction.update({
        where: { id: input.id },
        data: {
          status: 'resolved',
          decision: input.decision as object,
          resolvedAt: new Date(),
        },
      });

      // Reflect the outcome on the inline {type:'interaction'} card (externalId
      // int-<id>) so the timeline shows what was decided.
      const dup = await prisma.chatMessage.findFirst({
        where: { sessionId: i.sessionId, externalId: `int-${input.id}` },
        select: { id: true, content: true },
      });
      if (dup) {
        const blocks = Array.isArray(dup.content) ? (dup.content as Array<Record<string, unknown>>) : [];
        const next = blocks.map((b) =>
          b && b.type === 'interaction'
            ? { ...b, status: 'resolved', decision: input.decision }
            : b,
        );
        await prisma.chatMessage.update({ where: { id: dup.id }, data: { content: next as object } });
      }
      return updated;
    }),
});
