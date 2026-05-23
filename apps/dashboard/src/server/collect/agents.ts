// Filesystem snapshot for sibling agents under /Users/mac/claudeclaw/<agent>.
// Reads agent.pid, .claude/state/session-status.json, and the latest JSONL's
// last assistant message usage to derive context tokens.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prisma } from '../db';

const AGENTS_ROOT = '/Users/mac/claudeclaw';
const PROJECTS_ROOT = '/Users/mac/.claude/projects';

function readJson<T = unknown>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function sh(cmd: string, timeoutMs = 3000) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  return (r.stdout ?? '').trim();
}

// Cache claude-binary → cwd map across all agents in one snapshot. Avoids
// running lsof N times when scanning the agents tree.
let claudePidByCwd: Map<string, number> | null = null;
function findClaudeProcessByCwd(cwd: string): number | null {
  if (!claudePidByCwd) {
    claudePidByCwd = new Map();
    const pids = sh(`pgrep -u "$USER" -f '/.local/share/claude/versions/' 2>/dev/null`, 1500)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pidStr of pids) {
      const pid = Number(pidStr);
      if (!pid) continue;
      const lsofOut = sh(`lsof -a -p ${pid} -d cwd 2>/dev/null | tail -1`, 1500);
      const match = lsofOut.match(/\s(\/\S+)\s*$/);
      if (match) claudePidByCwd.set(match[1], pid);
    }
  }
  return claudePidByCwd.get(cwd) ?? null;
}

function latestJsonl(projectDir: string): { path: string; mtimeMs: number } | null {
  if (!fs.existsSync(projectDir)) return null;
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const ent of fs.readdirSync(projectDir)) {
    if (!ent.endsWith('.jsonl')) continue;
    const full = path.join(projectDir, ent);
    try {
      const st = fs.statSync(full);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return newest;
}

function lastUsage(jsonlPath: string): { totalIn: number; output: number } | null {
  const cmd = `grep '"type":"assistant"' ${JSON.stringify(jsonlPath)} | tail -1 | jq -c '.message.usage // empty' 2>/dev/null`;
  const stdout = sh(cmd);
  if (!stdout) return null;
  try {
    const u = JSON.parse(stdout) as Record<string, number>;
    return {
      totalIn:
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
    };
  } catch {
    return null;
  }
}

type AgentRow = {
  name: string;
  pid: number | null;
  alive: boolean;
  state: string | null;
  lastActivity: Date | null;
  transcriptPath: string | null;
  contextTokens: number | null;
  outputTokens: number | null;
};

function probeAgent(name: string): AgentRow | null {
  const dir = path.join(AGENTS_ROOT, name);
  if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) return null;

  const pidRaw = fs.existsSync(path.join(dir, 'agent.pid'))
    ? fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8').trim()
    : '';
  let pid: number | null = pidRaw && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
  let pidAlive = pid != null && alive(pid);

  if (!pidAlive) {
    const claudePid = findClaudeProcessByCwd(dir);
    if (claudePid) {
      pid = claudePid;
      pidAlive = true;
    }
  }

  const status = readJson<{ state?: string; last_activity?: string }>(
    path.join(dir, '.claude/state/session-status.json'),
  );

  const projectDir = path.join(PROJECTS_ROOT, `-Users-mac-claudeclaw-${name}`);
  const jsonl = latestJsonl(projectDir);
  const usage = jsonl ? lastUsage(jsonl.path) : null;

  return {
    name,
    pid,
    alive: pidAlive,
    state: status?.state ?? null,
    lastActivity: status?.last_activity
      ? new Date(status.last_activity)
      : jsonl
        ? new Date(jsonl.mtimeMs)
        : null,
    transcriptPath: jsonl?.path ?? null,
    contextTokens: usage?.totalIn ?? null,
    outputTokens: usage?.output ?? null,
  };
}

export async function collectAgents(machineId: string) {
  claudePidByCwd = null; // reset per-snapshot cache

  const dirs = (await fsp.readdir(AGENTS_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !['scripts', 'agentos'].includes(n));

  // Parallel filesystem probes — was sequential, took ~1s on 9 agents.
  const rows = (await Promise.all(dirs.map((n) => Promise.resolve(probeAgent(n))))).filter(
    (r): r is AgentRow => r !== null,
  );

  // Upsert each row.
  for (const row of rows) {
    await prisma.agent.upsert({
      where: { machineId_name: { machineId, name: row.name } },
      create: { ...row, machineId },
      update: row,
    });
  }

  // Drop agents not seen this scan.
  const names = rows.map((r) => r.name);
  await prisma.agent.deleteMany({ where: { machineId, NOT: { name: { in: names } } } });

  return rows.length;
}
