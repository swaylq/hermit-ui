// Dashboard-driven agent create/delete/edit. Polls AgentRequest rows
// (agents.pollRequests), scaffolds a new agent dir from apps/cli/template
// with placeholder substitution, soft-deletes one to the recycle bin (moves its
// dir to AGENTS_ROOT/.hermit-trash; restore moves it back, purge rm -rf's it —
// only for dirs inside AGENTS_ROOT; imported agents' sources are left alone), or
// writes a file edit, then acks (agents.ackRequest). Mirrors the chat-runner
// restart round-trip — the dashboard can't touch this host's FS.
//
// DB-leader (2026-05-29): Agent rows are created by the dashboard's tRPC
// mutations (requestCreate / requestImport); this module is only responsible
// for filesystem effects + a content sync after create.

import fs from 'node:fs';
import os from 'node:os';
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

// Overlay a marketplace template's files onto a freshly-scaffolded agent —
// IDENTITY.md / AGENTS.md / .claude/skills/<n>/SKILL.md only (allow-listed),
// with the same {{PLACEHOLDER}} substitution the base scaffold uses.
function overlayTemplate(dir: string, files: unknown, subs: Record<string, string>) {
  if (!Array.isArray(files)) return;
  const root = path.resolve(dir);
  const ALLOW = /^(IDENTITY\.md|AGENTS\.md|\.claude\/skills\/[a-z0-9][a-z0-9-]{0,30}\/SKILL\.md)$/;
  for (const f of files as Array<{ path?: unknown; content?: unknown }>) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    if (f.path.includes('..') || !ALLOW.test(f.path)) continue;
    const dst = path.resolve(root, f.path);
    if (!dst.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.content.replace(/\{\{(\w+)\}\}/g, (m: string, k: string) => (k in subs ? subs[k] : m)));
  }
}

// Mark an agent dir as trusted + onboarded in ~/.claude.json, so the
// gateway-spawned `claude` boots straight to the REPL instead of hanging
// (invisible, in a detached pane) on the "trust this folder?" / onboarding gates.
// Without this a dashboard-created agent's first chat/cron sticks in "starting"
// forever — claude never writes a transcript, so the runner times out. Idempotent;
// atomic write (tmp + rename) so a concurrent reader never sees a partial file.
function trustProject(dir: string): void {
  try {
    const cjPath = path.join(os.homedir(), '.claude.json');
    const cj = JSON.parse(fs.readFileSync(cjPath, 'utf8'));
    cj.projects = cj.projects ?? {};
    cj.projects[dir] = { ...(cj.projects[dir] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
    const tmp = `${cjPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cj, null, 2) + '\n');
    fs.renameSync(tmp, cjPath);
    console.log('[agent-lifecycle] trusted project', dir);
  } catch (e) {
    console.error('[agent-lifecycle] trustProject failed for', dir, e);
  }
}

// Scaffold a new agent at AGENTS_ROOT/<name>. Returns the resolved directory
// so the caller can push its initial content to the dashboard.
function scaffold(name: string, persona: string, templateFiles?: unknown): string {
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
  if (templateFiles) overlayTemplate(targetDir, templateFiles, subs);
  trustProject(targetDir); // pre-trust so the first gateway-spawned claude doesn't hang on trust/onboarding
  return targetDir;
}

// Recycle bin lives at AGENTS_ROOT/.hermit-trash/<name>. An agent's `name` is
// unique per machine and stays reserved while its row is trashed (we don't drop
// the row until purge), so a bare <name> never collides with another trashed
// agent. The dotdir is invisible to the DB-driven collectors (they read agent
// dirs from the DB, not by scanning AGENTS_ROOT).
function trashPathFor(name: string): string {
  return path.join(AGENTS_ROOT, '.hermit-trash', name);
}

// Is this a directory WE own — a direct child of AGENTS_ROOT? Path-only check:
// it does NOT require the dir to currently exist there, so it stays valid during
// restore (when the dir is sitting in .hermit-trash). Imported agents live
// outside AGENTS_ROOT; their recycle-bin lifecycle is DB-only — their source is
// never moved.
function isUnderAgentsRoot(directory: string | null): directory is string {
  if (!directory) return false;
  return path.dirname(path.resolve(directory)) === path.resolve(AGENTS_ROOT);
}

// Soft-delete: move the agent's dir into the recycle bin. For agents we
// scaffolded (dir under AGENTS_ROOT). Imported agents keep their source
// untouched — recycle-bin state is DB-only for them. The Agent row stays
// (trashed) until purge, so this is reversible via restoreAgent.
function deleteAgent(name: string, directory: string | null) {
  // Kill the tmux session regardless (defensive — there might be a stale pane).
  try { spawnSync('tmux', ['kill-session', '-t', `claude-${name}`], { timeout: 5_000 }); } catch { /* no pane */ }

  if (!isUnderAgentsRoot(directory)) return; // imported / no dir — nothing to move
  const home = path.resolve(directory);
  if (!fs.existsSync(home)) return;                          // already moved / gone
  if (!fs.existsSync(path.join(home, 'CLAUDE.md'))) return;  // not an agent dir — don't touch
  // Symlink guard (legacy v1 imports): unlink the link only, never its target.
  if (fs.lstatSync(home).isSymbolicLink()) { fs.unlinkSync(home); return; }

  const trash = trashPathFor(name);
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.rmSync(trash, { recursive: true, force: true }); // clear any stale trash entry
  fs.renameSync(home, trash);
}

// Restore from the recycle bin: move the dir back from .hermit-trash/ to its
// home path. DB-only for imported agents (their source never moved).
function restoreAgent(name: string, directory: string | null) {
  if (!isUnderAgentsRoot(directory)) return;
  const home = path.resolve(directory);
  const trash = trashPathFor(name);
  if (!fs.existsSync(trash)) return; // nothing trashed (imported / already restored)
  if (fs.existsSync(home)) return;   // home occupied — don't clobber; leave trash for manual recovery
  fs.mkdirSync(path.dirname(home), { recursive: true });
  fs.renameSync(trash, home);
}

// Permanent delete: rm -rf the trash dir. DB-only for imported agents (we never
// owned their source). Backstop: if a prior mv-to-trash failed and the dir is
// still at home, remove that too — purge means "gone for good" regardless.
function purgeAgent(name: string, directory: string | null) {
  try { spawnSync('tmux', ['kill-session', '-t', `claude-${name}`], { timeout: 5_000 }); } catch { /* no pane */ }
  const trash = trashPathFor(name);
  if (fs.existsSync(trash)) fs.rmSync(trash, { recursive: true, force: true });
  if (isUnderAgentsRoot(directory)) {
    const home = path.resolve(directory);
    if (fs.existsSync(path.join(home, 'CLAUDE.md'))) {
      if (fs.lstatSync(home).isSymbolicLink()) fs.unlinkSync(home);
      else fs.rmSync(home, { recursive: true, force: true });
    }
  }
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
  // evolution/<relpath> — any file in the agent's workspace evolution/ folder.
  // editAgentFile's containment guard blocks `..` traversal; reject obvious cases
  // here too. (memory/ is NOT editable — it's Claude Code's auto-memory.)
  const ev = target.match(/^evolution\/(.+)$/);
  if (ev && !ev[1].includes('..') && !ev[1].startsWith('/')) {
    return path.join('evolution', ev[1]);
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

// Write a market skill's sub-files ([{ path, content }]) into its on-disk skill
// dir. Paths come from the marketplace, so guard against `..` / absolute escapes —
// skip anything resolving outside skillDir. Called on install (the edit request
// carries `refs`); plain edits have none, so this is a no-op for them.
function writeSkillRefs(skillDir: string, refs: Array<{ path: string; content: string }> | null | undefined): number {
  if (!Array.isArray(refs)) return 0;
  const root = path.resolve(skillDir);
  let n = 0;
  for (const r of refs) {
    const rel = r?.path;
    const content = r?.content;
    if (typeof rel !== 'string' || typeof content !== 'string') continue;
    if (rel.includes('..') || rel.startsWith('/')) continue;
    const dst = path.resolve(root, rel);
    if (dst !== root && !dst.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
    n++;
  }
  return n;
}

// Remove a single skill dir from an agent (.claude/skills/<name>/). Backs the
// marketplace "uninstall" via the agent-request kind `delete-skill`.
function deleteAgentSkill(name: string, directory: string | null, target: string) {
  if (!directory) throw new Error('agent has no directory yet (still scaffolding?)');
  const agentDir = path.resolve(directory);
  if (!fs.existsSync(path.join(agentDir, 'CLAUDE.md'))) throw new Error('not an agent dir (no CLAUDE.md)');
  const m = target.match(/^skill:([a-z0-9][a-z0-9-]{0,30})$/);
  if (!m) throw new Error(`invalid delete-skill target: ${target}`);
  const skillsRoot = path.join(agentDir, '.claude', 'skills');
  const dst = path.resolve(skillsRoot, m[1]);
  if (!dst.startsWith(skillsRoot + path.sep)) throw new Error('resolved path escapes skills dir');
  fs.rmSync(dst, { recursive: true, force: true });
}

// Remove a STOPPED loop from <agentDir>/.loop-state.json by id — backs the
// dashboard's per-loop delete (agent-request kind `loop-delete`). Read-merge-
// write: preserves `schedules` and every other loop, drops only the one whose id
// matches AND whose status is not "running" (so a stale request can never nuke an
// active loop). The agent's own loop/cron skills also write this file, but a
// one-shot user delete vs an occasional skill write rarely collide and the worst
// case is a re-appearing entry, never corruption. Returns true if it removed one.
function deleteLoopFromState(name: string, directory: string | null, loopId: string): boolean {
  const agentDir = directory ?? path.join(AGENTS_ROOT, name);
  const p = path.join(path.resolve(agentDir), '.loop-state.json');
  let state: { loops?: unknown[]; [k: string]: unknown };
  try {
    state = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return false; // no file / unparseable → nothing to delete
  }
  if (!state || !Array.isArray(state.loops)) return false;
  const before = state.loops.length;
  state.loops = state.loops.filter(
    (l) =>
      !(
        l &&
        typeof l === 'object' &&
        (l as { id?: unknown }).id === loopId &&
        (l as { status?: unknown }).status !== 'running'
      ),
  );
  if (state.loops.length === before) return false;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return true;
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
          let templateFiles: unknown;
          if (r.content) { try { templateFiles = JSON.parse(r.content)?.templateFiles; } catch { /* not a template create */ } }
          const dir = scaffold(r.agentName, (r.persona || 'a hermit agent').trim(), templateFiles);
          refreshAfter.push({ name: r.agentName, directory: dir });
        } else if (r.kind === 'overlay') {
          // ensureBrain re-applying the brain's machine-managed files (the
          // `dreaming` skill) onto an ALREADY-scaffolded agent — overlayTemplate
          // straight onto the existing dir (scaffold would throw "exists"). The
          // allow-list (IDENTITY/AGENTS/skills SKILL.md) still applies; memory/ is
          // never reachable. Dashboard stamps brainTemplateVersion when it acks.
          const dir = r.agentDirectory ?? path.join(AGENTS_ROOT, r.agentName);
          if (!fs.existsSync(dir)) throw new Error(`overlay: agent dir missing: ${dir}`);
          let templateFiles: unknown;
          if (r.content) { try { templateFiles = JSON.parse(r.content)?.templateFiles; } catch { /* malformed */ } }
          if (!templateFiles) throw new Error('overlay request missing templateFiles');
          const subs: Record<string, string> = {
            AGENT_NAME: r.agentName,
            AGENT_DISPLAY_NAME: titlecase(r.agentName),
            PERSONA: (r.persona || '').trim(),
            USER_NAME: deriveUserName(),
            AGENT_DIR: path.resolve(dir),
            DASHBOARD_URL,
          };
          overlayTemplate(dir, templateFiles, subs);
          refreshAfter.push({ name: r.agentName, directory: dir });
        } else if (r.kind === 'delete') {
          deleteAgent(r.agentName, r.agentDirectory);
        } else if (r.kind === 'restore') {
          restoreAgent(r.agentName, r.agentDirectory);
        } else if (r.kind === 'purge') {
          purgeAgent(r.agentName, r.agentDirectory);
        } else if (r.kind === 'edit') {
          if (!r.target || r.content == null) throw new Error('edit request missing target/content');
          editAgentFile(r.agentName, r.agentDirectory, r.target, r.content);
          // Install bundles carry the skill's sub-files in `refs`; write the whole
          // tree into the skill dir, not just SKILL.md. (Plain edits have no refs.)
          const sm = r.target.match(/^skill:([a-z0-9][a-z0-9-]{0,30})$/);
          if (sm && r.agentDirectory && r.refs) {
            const wrote = writeSkillRefs(path.join(path.resolve(r.agentDirectory), '.claude', 'skills', sm[1]), r.refs);
            if (wrote) console.log(`[agent-lifecycle] ${r.agentName}: wrote ${wrote} sub-file(s) for skill ${sm[1]}`);
          }
          if (r.agentDirectory) refreshAfter.push({ name: r.agentName, directory: r.agentDirectory });
        } else if (r.kind === 'delete-skill') {
          if (!r.target) throw new Error('delete-skill request missing target');
          deleteAgentSkill(r.agentName, r.agentDirectory, r.target);
          if (r.agentDirectory) refreshAfter.push({ name: r.agentName, directory: r.agentDirectory });
        } else if (r.kind === 'loop-delete') {
          // Drop one stopped loop from .loop-state.json. No refreshAfter — loopState
          // is pushed by the session-snapshot tick (≤8s), not syncAgents.
          if (!r.target) throw new Error('loop-delete request missing target (loopId)');
          const removed = deleteLoopFromState(r.agentName, r.agentDirectory, r.target);
          console.log(`[agent-lifecycle] loop-delete ${r.agentName} ${r.target}: ${removed ? 'removed' : 'not found'}`);
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
