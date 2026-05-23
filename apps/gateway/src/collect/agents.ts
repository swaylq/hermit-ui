// Walk /Users/mac/claudeclaw/* for agents, probe state, return rows for upload.
// Same logic as the previous dashboard collect/agents.ts but pure (no DB write).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENTS_ROOT, PROJECTS_ROOT } from '../config';

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
function readJson<T = unknown>(p: string): T | null {
  const s = safeRead(p);
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
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
function sh(cmd: string, timeoutMs = 2000): string {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  return (r.stdout ?? '').trim();
}

let claudePidByCwd: Map<string, number> | null = null;
function findClaudeProcessByCwd(cwd: string): number | null {
  if (!claudePidByCwd) {
    claudePidByCwd = new Map();
    const pids = sh(`pgrep -u "$USER" -f '/.local/share/claude/versions/' 2>/dev/null`, 1500)
      .split('\n')
      .filter(Boolean);
    for (const pidStr of pids) {
      const pid = Number(pidStr);
      if (!pid) continue;
      const lsofOut = sh(`lsof -a -p ${pid} -d cwd 2>/dev/null | tail -1`, 1500);
      const m = lsofOut.match(/\s(\/\S+)\s*$/);
      if (m) claudePidByCwd.set(m[1], pid);
    }
  }
  return claudePidByCwd.get(cwd) ?? null;
}

function latestJsonl(projectDir: string): { path: string; mtimeMs: number } | null {
  if (!fs.existsSync(projectDir)) return null;
  let best: { path: string; mtimeMs: number } | null = null;
  for (const ent of fs.readdirSync(projectDir)) {
    if (!ent.endsWith('.jsonl')) continue;
    const full = path.join(projectDir, ent);
    try {
      const st = fs.statSync(full);
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return best;
}

function lastUsage(jsonlPath: string | null): { totalIn: number; output: number } | null {
  if (!jsonlPath) return null;
  const cmd = `grep '"type":"assistant"' ${JSON.stringify(jsonlPath)} | tail -1 | jq -c '.message.usage // empty' 2>/dev/null`;
  const out = sh(cmd, 3000);
  if (!out) return null;
  try {
    const u = JSON.parse(out);
    return {
      totalIn: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      output: u.output_tokens || 0,
    };
  } catch {
    return null;
  }
}

export type AgentRow = {
  name: string;
  pid: number | null;
  alive: boolean;
  state: string | null;
  contextTokens: number | null;
  outputTokens: number | null;
  lastActivity: string | null;
  transcriptPath: string | null;
};

function probe(name: string): AgentRow | null {
  const dir = path.join(AGENTS_ROOT, name);
  if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) return null;

  const pidRaw = (safeRead(path.join(dir, 'agent.pid')) ?? '').trim();
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
  const usage = lastUsage(jsonl?.path ?? null);

  return {
    name,
    pid,
    alive: pidAlive,
    state: status?.state ?? null,
    contextTokens: usage?.totalIn ?? null,
    outputTokens: usage?.output ?? null,
    lastActivity: status?.last_activity ?? (jsonl ? new Date(jsonl.mtimeMs).toISOString() : null),
    transcriptPath: jsonl?.path ?? null,
  };
}

export function collectAgents(): AgentRow[] {
  claudePidByCwd = null; // reset per call
  const dirs = fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !['scripts', 'agentos'].includes(n));
  return dirs
    .map((n) => probe(n))
    .filter((r): r is AgentRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
