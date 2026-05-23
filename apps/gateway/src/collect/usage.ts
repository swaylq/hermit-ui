// Hourly usage collector. Walks each agent's project dir JSONLs, parses each
// assistant message's timestamp + usage, tallies per hour bucket using ccusage
// pricing.
//
// For v1 we ship resolution = day (one bucket per agent per UTC day) because
// ccusage's `session` view only carries a date-level lastActivity. The
// dashboard's UsageHourly schema is granular enough to switch to true hour
// buckets later by parsing JSONL line-by-line.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_ROOT, PROJECTS_ROOT } from '../config';

type SessionRow = {
  period: string; // session UUID
  totalCost: number;
  totalTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: { lastActivity?: string };
};

export type UsageRow = {
  agentName: string;
  hourBucket: string; // ISO timestamp at hour boundary
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  sessions: number;
};

function listAgents(): string[] {
  return fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !['scripts', 'agentos'].includes(n))
    .filter((n) => fs.existsSync(path.join(AGENTS_ROOT, n, 'CLAUDE.md')));
}

function uuidByAgent(): Map<string, string> {
  const out = new Map<string, string>();
  for (const agent of listAgents()) {
    const dir = path.join(PROJECTS_ROOT, `-Users-mac-claudeclaw-${agent}`);
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir)) {
      if (!ent.endsWith('.jsonl')) continue;
      out.set(ent.replace(/\.jsonl$/, ''), agent);
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
  const r = spawnSync('npx', ['--yes', 'ccusage', 'session', '--json', '--since', since], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status !== 0) return [];

  let payload: { session?: SessionRow[] };
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const sessions = payload.session ?? [];
  const map = uuidByAgent();

  const buckets = new Map<string, UsageRow>(); // key = `${agent}|${hourBucket}`
  for (const s of sessions) {
    const agent = map.get(s.period);
    if (!agent) continue;
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
