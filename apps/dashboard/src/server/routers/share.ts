// Agent share links. The owner (a machine key) mints a per-agent `shr_…` token;
// whoever opens dash.swaylab.ai/s/<token> enters a dashboard scoped to ONLY that
// agent (see ../auth resolveKey + ../trpc agentProcedure). We store just the
// bcrypt hash, so the plaintext token is returned ONCE at create/regenerate time
// and the client builds the URL from its own origin. `redeem` (public) bootstraps
// the landing page; `whoami` tells the client whether it's in a scoped session.

import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { router, machineProcedure, publicProcedure, authedProcedure } from '../trpc';
import { prisma } from '../db';
import { SHARE_KEY_NS, shareKeyPrefix, invalidateShareCache, resolveKey } from '../auth';

const AgentName = z.object({ agentName: z.string().min(1).max(64) });

// shr_ + 32 url-safe chars (24 random bytes, base64url). Distinct namespace so
// the resolver can route it without a Machine-table lookup.
function mintToken(): string {
  return SHARE_KEY_NS + randomBytes(24).toString('base64url');
}

// Create or rotate the link for one agent, returning the plaintext token ONCE.
async function mintAndStore(machineId: string, agentName: string): Promise<{ token: string }> {
  // Don't mint a link for a non-existent agent (catches a typo'd agentName).
  const agent = await prisma.agent.findUnique({
    where: { machineId_name: { machineId, name: agentName } },
    select: { id: true },
  });
  if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent not found' });

  const token = mintToken();
  const keyHash = await bcrypt.hash(token, 10);
  const keyPrefix = shareKeyPrefix(token);

  // One link per (machine, agent): regenerate replaces the hash in place. Capture
  // the OLD prefix first so we can evict its cached resolution (instant revoke).
  const prev = await prisma.agentShareLink.findUnique({
    where: { machineId_agentName: { machineId, agentName } },
    select: { keyPrefix: true },
  });
  await prisma.agentShareLink.upsert({
    where: { machineId_agentName: { machineId, agentName } },
    create: { machineId, agentName, keyHash, keyPrefix },
    update: { keyHash, keyPrefix, lastUsedAt: null },
  });
  if (prev) invalidateShareCache(prev.keyPrefix);
  return { token };
}

export const shareRouter = router({
  // Owner-only: is there an active link for this agent? (never returns the token)
  get: machineProcedure.input(AgentName).query(async ({ ctx, input }) => {
    const link = await prisma.agentShareLink.findUnique({
      where: { machineId_agentName: { machineId: ctx.machine.id, agentName: input.agentName } },
      select: { createdAt: true, lastUsedAt: true },
    });
    return { exists: !!link, createdAt: link?.createdAt ?? null, lastUsedAt: link?.lastUsedAt ?? null };
  }),

  // Owner-only: create the link, returning the token once.
  create: machineProcedure.input(AgentName).mutation(({ ctx, input }) => mintAndStore(ctx.machine.id, input.agentName)),

  // Owner-only: rotate the token — the previous link stops working at once.
  regenerate: machineProcedure.input(AgentName).mutation(({ ctx, input }) => mintAndStore(ctx.machine.id, input.agentName)),

  // Owner-only: revoke (delete) the link.
  revoke: machineProcedure.input(AgentName).mutation(async ({ ctx, input }) => {
    const existing = await prisma.agentShareLink.findUnique({
      where: { machineId_agentName: { machineId: ctx.machine.id, agentName: input.agentName } },
      select: { keyPrefix: true },
    });
    if (existing) {
      await prisma.agentShareLink.delete({
        where: { machineId_agentName: { machineId: ctx.machine.id, agentName: input.agentName } },
      });
      invalidateShareCache(existing.keyPrefix);
    }
    return { ok: true };
  }),

  // Public: validate a token from the landing page → the minimal info needed to
  // bootstrap the scoped session. Token rides the INPUT (the active key isn't set
  // yet); it reveals only the agent + machine label the token already grants.
  redeem: publicProcedure.input(z.object({ token: z.string().min(8).max(128) })).mutation(async ({ input }) => {
    const r = await resolveKey(input.token);
    if (!r || r.scope !== 'agent') throw new TRPCError({ code: 'NOT_FOUND', message: 'invalid or revoked share link' });
    return { agentName: r.scopedAgent, machineName: r.machine.alias || r.machine.name };
  }),

  // Any valid key: who am I? Drives the client's scoped shell (hide everything
  // but the one agent when scope === 'agent').
  whoami: authedProcedure.query(({ ctx }) => ({ scope: ctx.scope, agentName: ctx.scopedAgent })),
});
