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
};

export type UsageRow = {
  agentName: string;
  hourBucket: string; // ISO timestamp at hour boundary (UTC day for v1)
  cost: number;
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
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      sessions: 0,
    };
    cur.cost += s.totalCost ?? 0;
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
