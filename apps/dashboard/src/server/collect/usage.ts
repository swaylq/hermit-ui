// ccusage-backed per-agent spend collector.
//
// ccusage returns session-level rows keyed by session UUID. Each Claude Code
// session has a JSONL at ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl, so we
// glob the agent's project dir to learn which UUIDs belong to which agent.
//
// Cached aggressively (60s) — ccusage scans every JSONL on disk, takes ~0.5s.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECTS_ROOT = '/Users/mac/.claude/projects';
const AGENTS_ROOT = '/Users/mac/claudeclaw';
const TTL_MS = 60_000;

type SessionRow = {
  period: string;            // session UUID
  totalCost: number;
  totalTokens: number;
  metadata?: { lastActivity?: string };
};

type AgentUsage = {
  agent: string;
  today: number;
  last7d: number;
  last30d: number;
  allTime: number;
  sessions: number;
  lastActivity: string | null;
};

let cached: { ts: number; rows: AgentUsage[] } | null = null;
let pending: Promise<AgentUsage[]> | null = null;

function listAgents(): string[] {
  try {
    return fs
      .readdirSync(AGENTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => !['scripts', 'agentos'].includes(n))
      .filter((n) => fs.existsSync(path.join(AGENTS_ROOT, n, 'CLAUDE.md')));
  } catch {
    return [];
  }
}

function uuidByAgent(): Map<string, string> {
  // map session UUID → agent name
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

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function collect(): Promise<AgentUsage[]> {
  // Fetch the last ~35 days of sessions so the 30d window is fully covered.
  const since = ymd(new Date(Date.now() - 35 * 86400_000));
  const r = spawnSync('npx', ['--yes', 'ccusage', 'session', '--json', '--since', since], {
    encoding: 'utf8',
    timeout: 15_000,
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

  const today = ymd(new Date());
  const cutoff7 = ymd(new Date(Date.now() - 7 * 86400_000));
  const cutoff30 = ymd(new Date(Date.now() - 30 * 86400_000));

  const agg = new Map<string, AgentUsage>();
  for (const s of sessions) {
    const agent = map.get(s.period);
    if (!agent) continue; // not one of our agents
    const last = s.metadata?.lastActivity ?? null;
    const cur = agg.get(agent) ?? {
      agent,
      today: 0,
      last7d: 0,
      last30d: 0,
      allTime: 0,
      sessions: 0,
      lastActivity: null,
    };
    cur.sessions += 1;
    cur.allTime += s.totalCost;
    if (last && last >= cutoff30) cur.last30d += s.totalCost;
    if (last && last >= cutoff7) cur.last7d += s.totalCost;
    if (last === today) cur.today += s.totalCost;
    if (!cur.lastActivity || (last && last > cur.lastActivity)) cur.lastActivity = last;
    agg.set(agent, cur);
  }

  // Ensure every known agent has a row, zero-filled.
  for (const agent of listAgents()) {
    if (!agg.has(agent))
      agg.set(agent, {
        agent,
        today: 0,
        last7d: 0,
        last30d: 0,
        allTime: 0,
        sessions: 0,
        lastActivity: null,
      });
  }

  return [...agg.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

export async function getUsage(): Promise<{ rows: AgentUsage[]; fetchedAt: Date; ttlMs: number }> {
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return { rows: cached.rows, fetchedAt: new Date(cached.ts), ttlMs: TTL_MS };
  }
  if (!pending) {
    pending = collect()
      .then((rows) => {
        cached = { ts: Date.now(), rows };
        return rows;
      })
      .finally(() => {
        pending = null;
      });
  }
  const rows = await pending;
  return { rows, fetchedAt: new Date(cached?.ts ?? Date.now()), ttlMs: TTL_MS };
}
