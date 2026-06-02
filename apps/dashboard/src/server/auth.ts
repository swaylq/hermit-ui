// Shared machine-key auth: prefix-filtered bcrypt + process-local cache.
//
// Used by BOTH the tRPC machineProcedure (browser reads) and the /api/sync/*
// routes (gateway writes). `bcrypt.compare` is CPU-bound (~50-200ms) and runs
// on the single Next event loop. Without caching, the gateway's per-transcript-
// event `syncChatMessages` floods /api/sync — and the OLD sync path did a
// full-table `findMany()` + a bcrypt against EVERY machine row per call. During
// an active chat turn that starved every concurrent request, so `pollChatPending`
// (and everything else) queued for ~30s in bursts. Cache + prefix filter makes
// repeat auths effectively free, which is what keeps the chat poll responsive.

import bcrypt from 'bcryptjs';
import { prisma } from './db';

export type MachineRow = Awaited<ReturnType<typeof prisma.machine.findMany>>[number];

interface AuthCacheEntry {
  machine: MachineRow;
  cachedAt: number;
  lastSeenBumpedAt: number;
}

const AUTH_TTL_MS = 5 * 60_000;
const LASTSEEN_DEBOUNCE_MS = 30_000;

// Process-local. pm2 cluster workers warm independently (fine — each is small).
const authCache = new Map<string, AuthCacheEntry>();

async function resolveUncached(keyPlain: string): Promise<MachineRow | null> {
  // keyPrefix is indexed, so this returns ~1 candidate — one bcrypt, not N.
  const prefix = keyPlain.slice(0, 8);
  const candidates = await prisma.machine.findMany({ where: { keyPrefix: prefix } });
  for (const m of candidates) {
    if (await bcrypt.compare(keyPlain, m.keyHash)) return m;
  }
  return null;
}

/**
 * Resolve a Machine from its plaintext X-Asst-Key. Cached for AUTH_TTL_MS; the
 * `lastSeen` bump is debounced + fire-and-forget so a tight poll/sync loop never
 * slams UPDATE or blocks the response. Returns null on missing/invalid key.
 */
export async function resolveMachineByKey(keyPlain: string): Promise<MachineRow | null> {
  if (!keyPlain) return null;

  let hit = authCache.get(keyPlain);
  if (hit && Date.now() - hit.cachedAt > AUTH_TTL_MS) {
    authCache.delete(keyPlain);
    hit = undefined;
  }
  if (!hit) {
    const machine = await resolveUncached(keyPlain);
    if (!machine) return null;
    hit = { machine, cachedAt: Date.now(), lastSeenBumpedAt: 0 };
    authCache.set(keyPlain, hit);
  }

  if (Date.now() - hit.lastSeenBumpedAt > LASTSEEN_DEBOUNCE_MS) {
    hit.lastSeenBumpedAt = Date.now();
    void prisma.machine
      .update({ where: { id: hit.machine.id }, data: { lastSeen: new Date() } })
      .catch(() => {});
  }

  return hit.machine;
}
