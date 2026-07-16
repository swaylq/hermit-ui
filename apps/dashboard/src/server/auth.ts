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

  // Debounced, fire-and-forget lastSeen bump (the share-link lastUsedAt bump below
  // mirrors this). Best-effort telemetry — a failed write just means the next
  // request re-bumps, so the error is intentionally dropped.
  if (Date.now() - hit.lastSeenBumpedAt > LASTSEEN_DEBOUNCE_MS) {
    hit.lastSeenBumpedAt = Date.now();
    void prisma.machine
      .update({ where: { id: hit.machine.id }, data: { lastSeen: new Date() } })
      .catch(() => {});
  }

  return hit.machine;
}

// Drop cached auth entries for a machine so the next request re-resolves fresh.
// Call after mutating cached machine fields (e.g. alias) — otherwise reads like
// machines.me serve a stale snapshot for up to AUTH_TTL_MS.
export function invalidateMachineCache(machineId: string): void {
  for (const [k, v] of authCache) {
    if (v.machine.id === machineId) authCache.delete(k);
  }
}

// ─── Agent share links: a scoped credential for ONE agent ────────────────────
// A share token (`shr_…`) authenticates as an AgentShareLink → access to a single
// agent on its machine and nothing else. Same prefix-filtered bcrypt as machines,
// but cached for only 30s so a revoked / regenerated link stops working quickly.

export const SHARE_KEY_NS = 'shr_'; // reserved token namespace (machine keys never use it)
export const SHARE_PREFIX_LEN = 12; // 'shr_' + 8 random chars — the indexed lookup column

export type ResolvedScope =
  | { scope: 'machine'; machine: MachineRow; scopedAgent: null }
  | { scope: 'agent'; machine: MachineRow; scopedAgent: string };

interface ShareCacheEntry {
  machine: MachineRow;
  agentName: string;
  keyPrefix: string;
  cachedAt: number;
  lastUsedBumpedAt: number;
}

const SHARE_TTL_MS = 30_000;
const shareCache = new Map<string, ShareCacheEntry>();

export function shareKeyPrefix(token: string): string {
  return token.slice(0, SHARE_PREFIX_LEN);
}

async function resolveShareUncached(keyPlain: string): Promise<ShareCacheEntry | null> {
  // keyPrefix is indexed → ~1 candidate, one bcrypt, like resolveUncached.
  const candidates = await prisma.agentShareLink.findMany({
    where: { keyPrefix: shareKeyPrefix(keyPlain) },
    include: { machine: true },
  });
  for (const link of candidates) {
    if (await bcrypt.compare(keyPlain, link.keyHash)) {
      return {
        machine: link.machine,
        agentName: link.agentName,
        keyPrefix: link.keyPrefix,
        cachedAt: Date.now(),
        lastUsedBumpedAt: 0,
      };
    }
  }
  return null;
}

async function resolveShareCached(keyPlain: string): Promise<ShareCacheEntry | null> {
  let hit = shareCache.get(keyPlain);
  if (hit && Date.now() - hit.cachedAt > SHARE_TTL_MS) {
    shareCache.delete(keyPlain);
    hit = undefined;
  }
  if (!hit) {
    hit = (await resolveShareUncached(keyPlain)) ?? undefined;
    if (!hit) return null;
    shareCache.set(keyPlain, hit);
  }
  // Debounced, fire-and-forget lastUsedAt bump (mirrors the machine lastSeen bump).
  if (Date.now() - hit.lastUsedBumpedAt > LASTSEEN_DEBOUNCE_MS) {
    hit.lastUsedBumpedAt = Date.now();
    void prisma.agentShareLink
      .updateMany({ where: { machineId: hit.machine.id, agentName: hit.agentName }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }
  return hit;
}

// Resolve a plaintext X-Asst-Key into its scope. `shr_` tokens take the share
// path (and never touch the Machine table — a non-match isn't cached, so this
// short-circuit keeps an active scoped poll from re-querying machines each time);
// everything else is a machine key (full access).
export async function resolveKey(keyPlain: string): Promise<ResolvedScope | null> {
  if (!keyPlain) return null;
  if (keyPlain.startsWith(SHARE_KEY_NS)) {
    const r = await resolveShareCached(keyPlain);
    return r ? { scope: 'agent', machine: r.machine, scopedAgent: r.agentName } : null;
  }
  const machine = await resolveMachineByKey(keyPlain);
  return machine ? { scope: 'machine', machine, scopedAgent: null } : null;
}

// Drop cached share resolutions for a key prefix so a revoked / regenerated link
// stops authenticating immediately on this worker (≤30s elsewhere via TTL).
export function invalidateShareCache(keyPrefix: string): void {
  for (const [k, v] of shareCache) {
    if (v.keyPrefix === keyPrefix) shareCache.delete(k);
  }
}
