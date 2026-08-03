// Per-agent usage collector. Runs `ccusage session --json` and tallies each
// claude session's tokens/cost into per-agent, per-UTC-day buckets the dashboard
// stores as UsageHourly rows.
//
// DB-leader (same model as chat-runner / session-snapshot / pushAgents): the set
// of agents AND each agent's on-disk path come straight from the dashboard DB via
// `api.listAgentDirectories()` (Agent.name + Agent.directory). We do NOT scan a
// filesystem root or reconstruct paths — we read each registered agent's stored
// `directory`, turn it into its claude project dir, and map the session UUIDs in
// that dir to the agent. So usage covers exactly the agents the dashboard knows
// about; agents absent from the DB are intentionally not reported.
//
// ccusage `session --json` row shape (ccusage 20.x, verified 2026-05-31):
//   { period: "<session-uuid>", metadata: { lastActivity: "YYYY-MM-DD" },
//     totalCost, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
// `period` IS the claude session uuid and `metadata.lastActivity` IS the date;
// the row's own `agent` field is unusable (always "Unknown"), so we attribute via
// which agent's project dir holds `<uuid>.jsonl`.
//
// Granularity caveat: ccusage's `session` view carries only a date-level
// lastActivity, so each session's spend lands in one UTC-day bucket. Per-agent
// TOTALS are exact; the hour/week time-series is day-grained. True hour buckets
// need line-by-line JSONL parsing — a later upgrade.

import fs from 'node:fs';
import { execCapture } from '../exec';
import { fitPrices, cacheReadCost, type ModelRow } from './pricing';
import { encodedProjectDir } from '@hermit-ui/tmux-driver';
import { api } from '../api';

type SessionRow = {
  period: string; // claude session uuid
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  metadata?: { lastActivity?: string };
  // Per-model split of the same session. Carries no per-token-type price, but across
  // hundreds of rows it pins one down — see collect/pricing.ts.
  modelBreakdowns?: Array<{
    modelName: string;
    cost?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }>;
};

export type UsageRow = {
  agentName: string;
  hourBucket: string; // ISO timestamp at hour boundary (UTC day for v1)
  cost: number;
  /**
   * `cost` with the cache-read tokens priced out of it. Cache reads are ~98% of the
   * tokens and ~60% of the dollars, and they are the SAME context being re-read every
   * turn — so this is the number that tracks new work rather than context size. Equal
   * to `cost` for any model whose price couldn't be derived (nothing is guessed).
   */
  costExCacheRead: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  sessions: number;
};

// session uuid → agentName, sourced from the DB's agent list. For each registered
// agent we read the claude project dir of its stored `directory` and claim every
// `<uuid>.jsonl` in it. Each agent.directory is distinct → a distinct project dir,
// so no uuid is claimed twice.
async function uuidByAgent(): Promise<Map<string, string>> {
  let agents: Array<{ name: string; directory: string | null }>;
  try {
    agents = await api.listAgentDirectories();
  } catch {
    return new Map();
  }
  const out = new Map<string, string>();
  for (const a of agents) {
    if (!a.directory) continue;
    let files: string[];
    try {
      files = fs.readdirSync(encodedProjectDir(a.directory));
    } catch {
      continue; // no project dir yet (agent never ran) — fine
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.set(f.replace(/\.jsonl$/, ''), a.name);
    }
  }
  return out;
}

function startOfUTCDay(dateStr: string): Date {
  const d = new Date(dateStr);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * The oldest bucket a run of `collectUsage(daysBack)` can produce. The push sends it
 * as the REPLACE boundary, so the dashboard drops everything from here on and takes
 * this run as the truth for the window.
 *
 * That replace is not housekeeping, it's the fix for a 6× overcount. A `ccusage
 * session` row carries the session's LIFETIME total against its LAST-activity date,
 * so while a session stays alive its whole running total is refiled onto each new
 * day it touches — and an upsert-only writer leaves every previous day's copy behind.
 * One long-lived session was banking its entire history once per day it was used:
 * asst read $27.4k over 30 days against $3.7k of actual session totals (2026-07-31).
 */
export function usageWindowStart(daysBack = 35): Date {
  return startOfUTCDay(new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10));
}

export async function collectUsage(daysBack = 35): Promise<UsageRow[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
  // Async spawn (not spawnSync) — ccusage takes 15-44s and must NOT freeze the
  // gateway's single event loop while it runs (that starved chat polls + ticks).
  const r = await execCapture('npx', ['--yes', 'ccusage', 'session', '--json', '--since', since], {
    timeoutMs: 90_000,
  });
  if (r.status !== 0) return [];

  let payload: { session?: SessionRow[] };
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const sessions = payload.session ?? [];
  const map = await uuidByAgent();

  // Derive the per-token prices from this very payload, then use them to price each
  // session's cache reads out of its total.
  const prices = fitPrices(
    sessions.flatMap((s) =>
      (s.modelBreakdowns ?? []).map((b): ModelRow => ({
        modelName: b.modelName,
        cost: b.cost ?? 0,
        inputTokens: b.inputTokens ?? 0,
        outputTokens: b.outputTokens ?? 0,
        cacheCreationTokens: b.cacheCreationTokens ?? 0,
        cacheReadTokens: b.cacheReadTokens ?? 0,
      })),
    ),
  );

  const buckets = new Map<string, UsageRow>(); // key = `${agent}|${hourBucket}`
  for (const s of sessions) {
    const agent = map.get(s.period);
    if (!agent) continue; // not a registered agent's session
    const last = s.metadata?.lastActivity;
    if (!last) continue;
    const bucket = startOfUTCDay(last); // day-level for v1
    const key = `${agent}|${bucket.toISOString()}`;
    const cur = buckets.get(key) ?? {
      agentName: agent,
      hourBucket: bucket.toISOString(),
      cost: 0,
      costExCacheRead: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      sessions: 0,
    };
    const total = s.totalCost ?? 0;
    // Never below zero, and never a "reduction" for a model we couldn't price: rows
    // with no fit contribute 0 to cacheReadCost, so their cost passes through whole.
    const exCache = Math.max(0, total - cacheReadCost(
      (s.modelBreakdowns ?? []).map((b): ModelRow => ({
        modelName: b.modelName,
        cost: b.cost ?? 0,
        inputTokens: b.inputTokens ?? 0,
        outputTokens: b.outputTokens ?? 0,
        cacheCreationTokens: b.cacheCreationTokens ?? 0,
        cacheReadTokens: b.cacheReadTokens ?? 0,
      })),
      prices,
    ));
    cur.cost += total;
    cur.costExCacheRead += exCache;
    cur.inputTokens += s.inputTokens ?? 0;
    cur.outputTokens += s.outputTokens ?? 0;
    cur.cacheCreationTokens += s.cacheCreationTokens ?? 0;
    cur.cacheReadTokens += s.cacheReadTokens ?? 0;
    cur.sessions += 1;
    buckets.set(key, cur);
  }
  return [...buckets.values()].sort((a, b) =>
    a.hourBucket < b.hourBucket ? -1 : a.hourBucket > b.hourBucket ? 1 : a.agentName.localeCompare(b.agentName),
  );
}
