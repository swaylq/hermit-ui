// global-skills.ts — manage the machine-global skills under ~/.claude/skills/
// (shared by every Claude Code session on this host, NOT scoped to an agent).
//
// Two halves, mirroring the agent collector + lifecycle:
//   - collectGlobalSkills() / pushGlobalSkills() — scan the dir, push to the
//     dashboard. The FILESYSTEM is the source of truth; the sync route upserts
//     what's pushed and deletes what's gone.
//   - globalSkillRequestTick() — poll dashboard-queued create/edit/delete
//     requests, apply them on disk, ack, and re-push so the UI updates fast.
//
// Bundles (git/plugin frameworks with a nested skills/ dir, e.g. superpowers)
// are surfaced read-only; the gateway refuses to edit/delete a dir that carries
// a .git or .claude-plugin marker (defense-in-depth on top of the router guard).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { api } from './api';

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const MAX_TEXT_BYTES = 64 * 1024; // SKILL.md can be large
const MAX_SKILL_FILES = 200;             // file-count ceiling for a published skill tree
const MAX_SKILL_BYTES = 2 * 1024 * 1024; // ~2MB total-tree budget (covers large skills like dws)
const REF_FILE_BYTES = 256 * 1024;       // per-file cap for tree files (larger than SKILL.md's 64KB)
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

function safeRead(p: string, maxBytes = MAX_TEXT_BYTES): string | null {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length <= maxBytes) return buf.toString('utf8');
    return buf.subarray(0, maxBytes).toString('utf8') + `\n\n…[truncated ${buf.length - maxBytes} bytes]`;
  } catch {
    return null;
  }
}

// Pull `name`/`description` from a SKILL.md YAML frontmatter block. Handles a
// single-line value (optionally quoted) and a `>`/`|` block scalar. Best-effort.
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const fm = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!fm) continue;
    const key = fm[1] as 'name' | 'description';
    let val = fm[2];
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) parts.push(lines[j].trim());
        else break;
      }
      val = parts.join(' ');
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    out[key] = val.trim();
  }
  return out;
}

function countFiles(dir: string, cap = 500): number {
  let n = 0;
  const walk = (d: string) => {
    if (n >= cap) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (n >= cap) return;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}

function detectSource(dir: string): 'git' | 'plugin' | 'manual' {
  if (fs.existsSync(path.join(dir, '.claude-plugin'))) return 'plugin';
  if (fs.existsSync(path.join(dir, '.git'))) return 'git';
  return 'manual';
}

function isManagedBundle(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude-plugin'));
}

// Capture the skill's WHOLE file tree (everything under <skill>/ except SKILL.md,
// which is `content`) as { path, content }: scripts/, references/ + its subdirs,
// LICENSE, etc. — so publishing a machine skill to the market ships the COMPLETE
// skill, not just references/*.md. Skips VCS/dep dirs + binary files; safeRead
// caps each file at 64KB; the whole tree is capped at MAX_SKILL_FILES.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|tgz|bz2|7z|rar|mp[34]|mov|avi|mkv|wav|ogg|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dat|class|jar|wasm|node)$/i;

function collectSkillFiles(skillDir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  let capped = false;
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_SKILL_FILES || bytes >= MAX_SKILL_BYTES) { capped = true; return; }
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), childRel); continue; }
      if (!e.isFile() || childRel === 'SKILL.md' || BINARY_EXT.test(e.name)) continue;
      const content = safeRead(path.join(dir, e.name), REF_FILE_BYTES);
      if (content != null) { out.push({ path: childRel, content }); bytes += content.length; }
    }
  };
  walk(skillDir, '');
  if (capped) console.warn(`[global-skills] ${path.basename(skillDir)}: tree capped (${out.length} files / ${Math.round(bytes / 1024)}KB)`);
  return out;
}

function bundleSubSkills(dir: string): string[] {
  const nested = path.join(dir, 'skills');
  if (!fs.existsSync(nested)) return [];
  try {
    return fs.readdirSync(nested, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(nested, d.name, 'SKILL.md')))
      .map((d) => d.name).sort();
  } catch { return []; }
}

export interface GlobalSkillRow {
  name: string;
  description: string | null;
  content: string | null;
  refs: Array<{ path: string; content: string }>;
  source: string;
  isBundle: boolean;
  subSkills: string[];
  fileCount: number;
}

function probe(dir: string, name: string): GlobalSkillRow | null {
  const source = detectSource(dir);
  const skillMd = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    const content = safeRead(skillMd) ?? '';
    const fm = parseFrontmatter(content);
    return {
      name,
      description: fm.description ?? null,
      content,
      refs: collectSkillFiles(dir),
      source,
      isBundle: false,
      subSkills: [],
      fileCount: countFiles(dir),
    };
  }
  // No top-level SKILL.md — a bundle/plugin with nested skills/ (e.g. superpowers).
  const subs = bundleSubSkills(dir);
  if (subs.length > 0 || source === 'plugin') {
    let description: string | null = null;
    const pj = safeRead(path.join(dir, '.claude-plugin', 'plugin.json'), 8 * 1024);
    if (pj) { try { description = JSON.parse(pj).description ?? null; } catch { /* ignore */ } }
    if (!description) {
      const readme = safeRead(path.join(dir, 'README.md'), 4 * 1024);
      if (readme) description = readme.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? null;
    }
    return {
      name,
      description: description ?? `Skill bundle (${subs.length} sub-skill${subs.length === 1 ? '' : 's'})`,
      content: null,
      refs: [],
      source,
      isBundle: true,
      subSkills: subs,
      fileCount: countFiles(dir),
    };
  }
  return null; // not a recognizable skill dir
}

export function collectGlobalSkills(): GlobalSkillRow[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  const rows: GlobalSkillRow[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const r = probe(path.join(SKILLS_DIR, e.name), e.name);
    if (r) rows.push(r);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// Skip the push when nothing changed. collectGlobalSkills() reads the (OS-cached)
// filesystem cheaply each tick, but the payload — every SKILL.md plus up to 20
// reference files each — is order-1MB and changes rarely; re-POSTing it to the
// dashboard every 60s, which then re-upserts every row, was pure churn. Hash the
// collected set and only push on a real change. lastSig is set AFTER a successful
// push, so a failed POST simply retries on the next tick. (No liveness display
// depends on the periodic push — global-skill metadataAt isn't shown anywhere.)
let lastSig: string | null = null;
export async function pushGlobalSkills(): Promise<void> {
  const rows = collectGlobalSkills();
  const sig = crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex');
  if (sig === lastSig) return;
  await api.syncGlobalSkills(rows);
  lastSig = sig;
}

// ── Lifecycle (apply dashboard-queued create/edit/delete on disk) ─────────────

// Write an installed skill's sub-files ([{ path, content }]) into its dir. Paths
// come from the marketplace, so guard against `..` / absolute escapes.
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

function applyGlobalSkillRequest(req: { kind: string; skillName: string; content: string | null; refs?: Array<{ path: string; content: string }> | null }): void {
  const name = req.skillName;
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`);
  const dir = path.join(SKILLS_DIR, name);
  if (path.dirname(dir) !== SKILLS_DIR) throw new Error('path escapes skills dir'); // traversal guard

  if (req.kind === 'create') {
    if (fs.existsSync(dir)) throw new Error('skill already exists on disk');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), req.content ?? '');
    writeSkillRefs(dir, req.refs);
  } else if (req.kind === 'edit') {
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('SKILL.md not found');
    if (isManagedBundle(dir)) throw new Error('managed bundle (git/plugin) — refusing to edit');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), req.content ?? '');
    writeSkillRefs(dir, req.refs);
  } else if (req.kind === 'delete') {
    if (!fs.existsSync(dir)) return; // already gone
    if (isManagedBundle(dir)) throw new Error('managed bundle (git/plugin) — refusing to delete');
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    throw new Error(`unknown kind: ${req.kind}`);
  }
}

let busy = false;
export async function globalSkillRequestTick(): Promise<void> {
  if (busy) return;
  busy = true;
  let changed = false;
  try {
    const reqs = await api.pollGlobalSkillRequests();
    for (const r of reqs) {
      try {
        applyGlobalSkillRequest(r);
        await api.ackGlobalSkillRequest({ id: r.id, status: 'done' });
        changed = true;
      } catch (e) {
        await api.ackGlobalSkillRequest({ id: r.id, status: 'error', error: String((e as Error)?.message ?? e) });
      }
    }
    if (changed) await pushGlobalSkills(); // reflect the change immediately
  } finally {
    busy = false;
  }
}
