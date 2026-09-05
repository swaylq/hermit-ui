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
import { SwrCache } from './swr-cache';

export type MachineRow = Awaited<ReturnType<typeof prisma.machine.findMany>>[number];

const AUTH_TTL_MS = 5 * 60_000;
const LASTSEEN_DEBOUNCE_MS = 30_000;

async function resolveUncached(keyPlain: string): Promise<MachineRow | null> {
  // keyPrefix is indexed, so this returns ~1 candidate — one bcrypt, not N.
  const prefix = keyPlain.slice(0, 8);
  const candidates = await prisma.machine.findMany({ where: { keyPrefix: prefix } });
  for (const m of candidates) {
    if (await bcrypt.compare(keyPlain, m.keyHash)) return m;
  }
  return null;
}

// Process-local. pm2 cluster workers warm independently (fine — each is small).
//
// Not a plain TTL map (swr-cache.ts says what that cost): a key past AUTH_TTL_MS
// is still answered from its entry while one refresh runs behind it, and
// concurrent misses share a single bcrypt. Every gateway's key was cached in the
// same second after each deploy, so they all expired together, and the twenty
// pollers that arrived next each ran their own 320ms compare — a 5–9s stall of
// the whole dashboard every five minutes, for days (2026-09-05).
const machineCache = new SwrCache<MachineRow>({ freshMs: AUTH_TTL_MS, resolve: resolveUncached });

// Machine id → when lastSeen was last bumped. Beside the cache rather than in
// it, so a background refresh does not reset the debounce.
const lastSeenBumpedAt = new Map<string, number>();

/**
 * Resolve a Machine from its plaintext X-Asst-Key. Cached (fresh for AUTH_TTL_MS,
 * then refreshed behind the caller); the `lastSeen` bump is debounced +
 * fire-and-forget so a tight poll/sync loop never slams UPDATE or blocks the
 * response. Returns null on missing/invalid key.
 */
export async function resolveMachineByKey(keyPlain: string): Promise<MachineRow | null> {
  if (!keyPlain) return null;
  const machine = await machineCache.get(keyPlain);
  if (!machine) return null;

  // Debounced, fire-and-forget lastSeen bump (the share-link lastUsedAt bump below
  // mirrors this). Best-effort telemetry — a failed write just means the next
  // request re-bumps, so the error is intentionally dropped.
  const now = Date.now();
  if (now - (lastSeenBumpedAt.get(machine.id) ?? 0) > LASTSEEN_DEBOUNCE_MS) {
    lastSeenBumpedAt.set(machine.id, now);
    void prisma.machine
      .update({ where: { id: machine.id }, data: { lastSeen: new Date() } })
      .catch(() => {});
  }

  return machine;
}

// Drop cached auth entries for a machine so the next request re-resolves fresh.
// Call after mutating cached machine fields (e.g. alias) — otherwise reads like
// machines.me serve a stale snapshot for up to AUTH_TTL_MS.
export function invalidateMachineCache(machineId: string): void {
  machineCache.deleteWhere((m) => m.id === machineId);
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

interface ShareEntry {
  machine: MachineRow;
  agentName: string;
  keyPrefix: string;
}

const SHARE_TTL_MS = 30_000;

export function shareKeyPrefix(token: string): string {
  return token.slice(0, SHARE_PREFIX_LEN);
}

async function resolveShareUncached(keyPlain: string): Promise<ShareEntry | null> {
  // keyPrefix is indexed → ~1 candidate, one bcrypt, like resolveUncached.
  const candidates = await prisma.agentShareLink.findMany({
    where: { keyPrefix: shareKeyPrefix(keyPlain) },
    include: { machine: true },
  });
  for (const link of candidates) {
    if (await bcrypt.compare(keyPlain, link.keyHash)) {
      return { machine: link.machine, agentName: link.agentName, keyPrefix: link.keyPrefix };
    }
  }
  return null;
}

// Same discipline as machineCache. A revoked link is refused by the refresh that
// the first request after SHARE_TTL_MS starts — one request later than a plain
// expiry — and at once on this worker through invalidateShareCache.
const shareCache = new SwrCache<ShareEntry>({ freshMs: SHARE_TTL_MS, resolve: resolveShareUncached });
const lastUsedBumpedAt = new Map<string, number>(); // `${machineId}/${agentName}` → ms

async function resolveShareCached(keyPlain: string): Promise<ShareEntry | null> {
  const hit = await shareCache.get(keyPlain);
  if (!hit) return null;
  // Debounced, fire-and-forget lastUsedAt bump (mirrors the machine lastSeen bump).
  const k = `${hit.machine.id}/${hit.agentName}`;
  const now = Date.now();
  if (now - (lastUsedBumpedAt.get(k) ?? 0) > LASTSEEN_DEBOUNCE_MS) {
    lastUsedBumpedAt.set(k, now);
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
  shareCache.deleteWhere((v) => v.keyPrefix === keyPrefix);
}
