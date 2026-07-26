// The reconciliation rules for one sync pass, isolated from the engine that
// performs them. Pure and import-free (types only), so the rules can be tested
// without a server, a database, or a browser.

import type { CachedSession } from './types';

export type ProbeRow = {
  sessionId: string;
  agentName: string;
  title: string | null;
  preview: string | null;
  watermark: number; // MAX(ChatMessage.updatedAt) in ms
  count: number;
};

export type SyncPlan = {
  /** Sessions the server no longer reports — deleted upstream. */
  drop: string[];
  /** Sessions to pull, newest activity first. `reset` wipes before refetching. */
  fetch: Array<{ probe: ProbeRow; since: number; reset: boolean }>;
  /** Already level with the server. */
  upToDate: ProbeRow[];
};

/**
 * Decide what a sync pass has to do.
 *
 *   · not cached                → full fetch from 0
 *   · cached count > server's   → a row was DELETED (dequeue / clearQueue); the
 *                                 watermark can't see that and a delta fetch
 *                                 can't repair it, so wipe and refetch
 *   · watermark or count moved  → delta fetch from the cached watermark
 *   · otherwise                 → nothing to do
 */
export function planSync(probe: ProbeRow[], cached: Iterable<CachedSession>): SyncPlan {
  const local = new Map<string, CachedSession>();
  for (const c of cached) local.set(c.sessionId, c);
  const live = new Set(probe.map((p) => p.sessionId));

  const plan: SyncPlan = { drop: [], fetch: [], upToDate: [] };
  for (const id of local.keys()) if (!live.has(id)) plan.drop.push(id);

  // Newest first: what the user is likely to search for is what they were just
  // talking about, so a cold start should make that searchable first.
  for (const p of [...probe].sort((a, b) => b.watermark - a.watermark)) {
    const l = local.get(p.sessionId);
    if (l && l.watermark === p.watermark && l.count === p.count) {
      plan.upToDate.push(p);
      continue;
    }
    const reset = !!l && l.count > p.count;
    plan.fetch.push({ probe: p, since: !l || reset ? 0 : l.watermark, reset });
  }
  return plan;
}
