// Dashboard-driven agent create/delete/edit. Polls AgentRequest rows
// (agents.pollRequests), scaffolds a new agent dir from apps/cli/template
// with placeholder substitution, rm -rf's an existing one (only if it lives
// inside AGENTS_ROOT — imported agents' source dirs are left untouched), or
// writes a file edit, then acks (agents.ackRequest). Mirrors the chat-runner
// restart round-trip — the dashboard can't touch this host's FS.
//
// DB-leader (2026-05-29): Agent rows are created by the dashboard's tRPC
// mutations (requestCreate / requestImport); this module is only responsible
// for filesystem effects + a content sync after create.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AGENTS_ROOT, DASHBOARD_URL } from './config';
import { api } from './api';
import { readAgent } from './collect/agents';

// Template lives at apps/cli/template, relative to this file (apps/gateway/src).
const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'template');

function titlecase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Reuse the user's name from an existing sibling agent's USER.md so a new agent
// addresses the same person consistently. Falls back to env / "friend".
function deriveUserName(): string {
  try {
    for (const d of fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const up = path.join(AGENTS_ROOT, d.name, 'USER.md');
      if (!fs.existsSync(up)) continue;
      const m = fs.readFileSync(up, 'utf8').match(/\*\*Name:\*\*\s*(.+)/);
      const nm = m?.[1]?.trim();
      if (nm && !nm.includes('{{')) return nm;
    }
  } catch { /* ignore */ }
  return process.env.HERMIT_USER_NAME || 'friend';
}

// Treat these as text (substitute placeholders); everything else byte-copied.
const TEXT_EXT = new Set(['.md', '.sh', '.json', '.txt', '.js', '.ts', '.cjs', '.mjs', '.toml', '.yaml', '.yml', '']);

function walkCopy(src: string, dst: string, subs: Record<string, string>) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) { walkCopy(s, d, subs); continue; }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const isText = entry.name.startsWith('.') || TEXT_EXT.has(ext);
    if (isText) {
      const content = fs.readFileSync(s, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in subs ? subs[k] : m));
      fs.writeFileSync(d, content);
    } else {
      fs.copyFileSync(s, d);
    }
    try { if (fs.statSync(s).mode & 0o111) fs.chmodSync(d, 0o755); } catch { /* best effort */ }
  }
}

// Scaffold a new agent at AGENTS_ROOT/<name>. Returns the resolved directory
// so the caller can push its initial content to the dashboard.
function scaffold(name: string, persona: string): string {
  const targetDir = path.join(AGENTS_ROOT, name);
  if (fs.existsSync(targetDir)) throw new Error(`directory already exists: ${targetDir}`);
  if (!fs.existsSync(TEMPLATE_DIR)) throw new Error(`template not found: ${TEMPLATE_DIR}`);
  const subs: Record<string, string> = {
    AGENT_NAME: name,
    AGENT_DISPLAY_NAME: titlecase(name),
    PERSONA: persona,
    USER_NAME: deriveUserName(),
    AGENT_DIR: targetDir,
    DASHBOARD_URL,
  };
  // Build in a sidecar dir then atomically rename, so a half-written scaffold
  // never looks like a real agent to collectAgents (which keys on CLAUDE.md).
  const tmp = `${targetDir}.scaffolding`;
  fs.rmSync(tmp, { recursive: true, force: true });
  walkCopy(TEMPLATE_DIR, tmp, subs);
  // settings.local.json carries env; it's gitignored so not in the template.
  fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'settings.local.json'),
    JSON.stringify({ env: { HERMIT_DASHBOARD_URL: DASHBOARD_URL } }, null, 2) + '\n',
  );
  fs.renameSync(tmp, targetDir);
  return targetDir;
}

// Delete an agent's filesystem footprint. For agents we scaffolded, that's the
// dir under AGENTS_ROOT — rm -rf. For imported agents (directory lives outside
// AGENTS_ROOT), we leave the source folder alone; the dashboard handles row
// deletion in ackRequest.
function deleteAgent(name: string, directory: string | null) {
  // Kill the tmux session regardless (defensive — there might be a stale pane).
  try { spawnSync('tmux', ['kill-session', '-t', `claude-${name}`], { timeout: 5_000 }); } catch { /* no pane */ }

  if (!directory) return;  // Never had a directory (failed scaffold) — nothing to remove.

  const resolved = path.resolve(directory);
  const rootResolved = path.resolve(AGENTS_ROOT);
  // Only touch the filesystem if the directory is a direct child of AGENTS_ROOT
  // — i.e. an agent WE scaffolded. Anything else (imported path) is the user's
  // own working copy; out of scope.
  if (path.dirname(resolved) !== rootResolved) return;
  if (!fs.existsSync(path.join(resolved, 'CLAUDE.md'))) return;  // not an agent dir
  // Defense in depth: in case anyone left a symlink in there from the v1 import
  // flow, unlink the link only — never recurse into its target.
  const ls = fs.lstatSync(resolved);
  if (ls.isSymbolicLink()) fs.unlinkSync(resolved);
  else fs.rmSync(resolved, { recursive: true, force: true });
}

// Map an opaque editor target → a relative path inside the agent dir. Anything
// not on this allow-list is rejected; the dashboard tRPC also validates, this
// is defense in depth.
function targetToRelPath(target: string): string {
  switch (target) {
    case 'identity':  return 'IDENTITY.md';
    case 'user':      return 'USER.md';
    case 'agents':    return 'AGENTS.md';
    case 'tools':     return 'TOOLS.md';
    case 'evolution': return path.join('evolution', 'lessons.md');
    case 'claude':    return 'CLAUDE.md';
  }
  const m = target.match(/^skill:([a-z0-9][a-z0-9-]{0,30})$/);
  if (m) return path.join('.claude', 'skills', m[1], 'SKILL.md');
  throw new Error(`invalid target: ${target}`);
}

function editAgentFile(name: string, directory: string | null, target: string, content: string) {
  if (!directory) throw new Error('agent has no directory yet (still scaffolding?)');
  const agentDir = path.resolve(directory);
  if (!fs.existsSync(path.join(agentDir, 'CLAUDE.md'))) throw new Error('not an agent dir (no CLAUDE.md)');
  const rel = targetToRelPath(target);
  const dst = path.resolve(agentDir, rel);
  // Containment: the resolved path must be a descendant of agentDir (covers
  // any pathological slug that slips past targetToRelPath's regex).
  if (!dst.startsWith(agentDir + path.sep)) throw new Error('resolved path escapes agent dir');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
}

let busy = false;
export async function agentRequestTick() {
  if (busy) return;
  busy = true;
  try {
    const reqs = await api.pollAgentRequests();
    if (reqs.length === 0) return;
    // Track which agents had content changes so we can push them immediately
    // (after scaffold the dashboard's Agent row is empty — we want it filled
    // in within seconds, not after the next 5-min pushAgents tick).
    const refreshAfter: Array<{ name: string; directory: string }> = [];
    for (const r of reqs) {
      try {
        if (r.kind === 'create') {
          const dir = scaffold(r.agentName, (r.persona || 'a hermit agent').trim());
          refreshAfter.push({ name: r.agentName, directory: dir });
        } else if (r.kind === 'delete') {
          deleteAgent(r.agentName, r.agentDirectory);
        } else if (r.kind === 'edit') {
          if (!r.target || r.content == null) throw new Error('edit request missing target/content');
          editAgentFile(r.agentName, r.agentDirectory, r.target, r.content);
          if (r.agentDirectory) refreshAfter.push({ name: r.agentName, directory: r.agentDirectory });
        } else {
          throw new Error(`unknown request kind: ${r.kind}`);
        }
        await api.ackAgentRequest({ id: r.id, status: 'done' });
        console.log(`[agent-lifecycle] ${r.kind} ${r.agentName} ok`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[agent-lifecycle] ${r.kind} ${r.agentName} failed:`, msg);
        await api.ackAgentRequest({ id: r.id, status: 'error', error: msg }).catch(() => {});
      }
    }
    // Push fresh content for any agent we just scaffolded or edited so the
    // dashboard reflects it without waiting for the next pushAgents tick.
    if (refreshAfter.length > 0) {
      const rows = refreshAfter
        .map(({ name, directory }) => readAgent(directory, name))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (rows.length > 0) {
        try { await api.syncAgents(rows); } catch { /* next pushAgents tick will */ }
      }
    }
  } finally {
    busy = false;
  }
}
