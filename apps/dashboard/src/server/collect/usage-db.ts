// DB-backed usage view used when GATEWAY_DRIVEN=1 (VPS deployment). The
// gateway POSTs UsageHourly rows; here we aggregate on read.
import { prisma } from '../db';

export type AgentUsage = {
  agent: string;
  today: number;
  last7d: number;
  last30d: number;
  allTime: number;
  sessions: number;
  lastActivity: string | null;
};

const CACHE_TTL_MS = 30_000;
const cacheByMachine = new Map<string, { ts: number; rows: AgentUsage[] }>();

function startOfTodayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getUsageFromDb(machineId: string): Promise<{
  rows: AgentUsage[];
  fetchedAt: Date;
  ttlMs: number;
}> {
  const c = cacheByMachine.get(machineId);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) {
    return { rows: c.rows, fetchedAt: new Date(c.ts), ttlMs: CACHE_TTL_MS };
  }

  const todayBucket = startOfTodayUTC();
  const cutoff7 = new Date(Date.now() - 7 * 86400_000);
  const cutoff30 = new Date(Date.now() - 30 * 86400_000);

  // One pass: sum cost per agent within each window. Aggregate via Postgres
  // for the all-time view (could be many rows over time).
  const rowsRaw = await prisma.usageHourly.findMany({
    where: { machineId, hourBucket: { gte: cutoff30 } },
    orderBy: { hourBucket: 'asc' },
  });

  // Pre-fetch all-time and sessions counts via separate aggregates so the
  // bigger query doesn't ship every row.
  const allTimeAgg = await prisma.usageHourly.groupBy({
    by: ['agentName'],
    where: { machineId },
    _sum: { cost: true, sessions: true },
    _max: { hourBucket: true },
  });

  const map = new Map<string, AgentUsage>();
  for (const a of allTimeAgg) {
    map.set(a.agentName, {
      agent: a.agentName,
      today: 0,
      last7d: 0,
      last30d: 0,
      allTime: a._sum.cost ?? 0,
      sessions: a._sum.sessions ?? 0,
      lastActivity: a._max.hourBucket ? a._max.hourBucket.toISOString() : null,
    });
  }

  for (const r of rowsRaw) {
    const cur = map.get(r.agentName);
    if (!cur) continue;
    cur.last30d += r.cost;
    if (r.hourBucket >= cutoff7) cur.last7d += r.cost;
    if (r.hourBucket >= todayBucket) cur.today += r.cost;
  }

  // Also include agents present in the Agent table but no usage yet, so the
  // table is consistent with the agent sidebar.
  const agentRows = await prisma.agent.findMany({
    where: { machineId },
    select: { name: true },
  });
  for (const a of agentRows) {
    if (!map.has(a.name)) {
      map.set(a.name, {
        agent: a.name,
        today: 0,
        last7d: 0,
        last30d: 0,
        allTime: 0,
        sessions: 0,
        lastActivity: null,
      });
    }
  }

  const rows = [...map.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  cacheByMachine.set(machineId, { ts: Date.now(), rows });
  return { rows, fetchedAt: new Date(), ttlMs: CACHE_TTL_MS };
}

export async function getUsageByHour(machineId: string, hours = 48) {
  const cutoff = new Date(Date.now() - hours * 3600_000);
  cutoff.setUTCMinutes(0, 0, 0);
  const rows = await prisma.usageHourly.findMany({
    where: { machineId, hourBucket: { gte: cutoff } },
    orderBy: { hourBucket: 'asc' },
  });
  return rows.map((r) => ({
    agent: r.agentName,
    hour: r.hourBucket.toISOString(),
    cost: r.cost,
    // token columns are BigInt (INT8) in the DB; each is well under 2^53, so sum as
    // plain numbers to keep the wire type stable and avoid BigInt in the client.
    tokens: Number(r.inputTokens) + Number(r.outputTokens) + Number(r.cacheCreationTokens) + Number(r.cacheReadTokens),
    sessions: r.sessions,
  }));
}

export async function getUsageByWeek(machineId: string, weeks = 12) {
  const cutoff = new Date(Date.now() - weeks * 7 * 86400_000);
  cutoff.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.usageHourly.findMany({
    where: { machineId, hourBucket: { gte: cutoff } },
    select: { agentName: true, hourBucket: true, cost: true },
  });

  function isoWeekKey(d: Date): string {
    // ISO week starting Monday, UTC.
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dow);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((+tmp - +yearStart) / 86400_000 + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  const agg = new Map<string, Map<string, number>>(); // agent → week → cost
  for (const r of rows) {
    const wk = isoWeekKey(r.hourBucket);
    let m = agg.get(r.agentName);
    if (!m) {
      m = new Map();
      agg.set(r.agentName, m);
    }
    m.set(wk, (m.get(wk) ?? 0) + r.cost);
  }

  const out: Array<{ agent: string; week: string; cost: number }> = [];
  for (const [agent, byWeek] of agg) {
    for (const [week, cost] of byWeek) {
      out.push({ agent, week, cost });
    }
  }
  return out.sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : a.agent.localeCompare(b.agent)));
}
