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
import { SHARE_KEY_NS, shareKeyPrefix, publicShareToken, invalidateShareCache, resolveKey } from '../auth';

const AgentName = z.object({ agentName: z.string().min(1).max(64) });

// shr_ + 32 url-safe chars (24 random bytes, base64url). Distinct namespace so
// the resolver can route it without a Machine-table lookup.
function mintToken(): string {
  return SHARE_KEY_NS + randomBytes(24).toString('base64url');
}

// Create or rotate the link for one agent, returning the plaintext token ONCE.
// `publicFlag` (optional) chooses public vs private; undefined preserves the
// existing link's mode (so a regenerate on an existing link never silently flips
// it). Public links use a deterministic `pub_` token — no secret, no bcrypt.
async function mintAndStore(
  machineId: string,
  agentName: string,
  publicFlag?: boolean,
): Promise<{ token: string; isPublic: boolean }> {
  // Don't mint a link for a non-existent agent (catches a typo'd agentName).
  const agent = await prisma.agent.findUnique({
    where: { machineId_name: { machineId, name: agentName } },
    select: { id: true },
  });
  if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent not found' });

  // One link per (machine, agent): regenerate replaces the hash in place. Capture
  // the OLD prefix first so we can evict its cached resolution (instant revoke),
  // and read the current mode so an unspecified flag preserves it.
  const prev = await prisma.agentShareLink.findUnique({
    where: { machineId_agentName: { machineId, agentName } },
    select: { keyPrefix: true, isPublic: true },
  });
  const isPublic = publicFlag ?? prev?.isPublic ?? false;

  let token: string;
  let keyHash: string;
  if (isPublic) {
    const machine = await prisma.machine.findUnique({ where: { id: machineId }, select: { name: true } });
    if (!machine) throw new TRPCError({ code: 'NOT_FOUND', message: 'machine not found' });
    token = publicShareToken(machine.name, agentName);
    keyHash = token; // placeholder only — public resolution never bcrypts (no secret)
  } else {
    token = mintToken();
    keyHash = await bcrypt.hash(token, 10);
  }
  const keyPrefix = shareKeyPrefix(token);

  await prisma.agentShareLink.upsert({
    where: { machineId_agentName: { machineId, agentName } },
    create: { machineId, agentName, keyHash, keyPrefix, isPublic },
    update: { keyHash, keyPrefix, isPublic, lastUsedAt: null },
  });
  if (prev) invalidateShareCache(prev.keyPrefix);
  return { token, isPublic };
}

export const shareRouter = router({
  // Owner-only: is there an active link for this agent? (never returns the PRIVATE
  // token; a public link's deterministic token IS returned so the owner can re-copy
  // its URL — it's not a secret.)
  get: machineProcedure.input(AgentName).query(async ({ ctx, input }) => {
    const link = await prisma.agentShareLink.findUnique({
      where: { machineId_agentName: { machineId: ctx.machine.id, agentName: input.agentName } },
      select: { createdAt: true, lastUsedAt: true, isPublic: true },
    });
    return {
      exists: !!link,
      createdAt: link?.createdAt ?? null,
      lastUsedAt: link?.lastUsedAt ?? null,
      isPublic: link?.isPublic ?? false,
      publicToken: link?.isPublic ? publicShareToken(ctx.machine.name, input.agentName) : null,
    };
  }),

  // Owner-only: create the link, returning the token once. `public: true` makes it
  // a no-password public link (the dialog confirms this with the owner first).
  create: machineProcedure
    .input(AgentName.extend({ public: z.boolean().optional() }))
    .mutation(({ ctx, input }) => mintAndStore(ctx.machine.id, input.agentName, input.public)),

  // Owner-only: rotate the token — the previous link stops working at once. A
  // public link is deterministic, so "regenerate" there only re-stamps the row.
  regenerate: machineProcedure
    .input(AgentName.extend({ public: z.boolean().optional() }))
    .mutation(({ ctx, input }) => mintAndStore(ctx.machine.id, input.agentName, input.public)),

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
