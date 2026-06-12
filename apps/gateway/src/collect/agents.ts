// collect/agents.ts — STATIC metadata reader.
//
// DB-leader model (2026-05-29): the gateway no longer scans AGENTS_ROOT.
// `pushAgents` in index.ts pulls the list of {name, directory} from the
// dashboard (api.listAgentDirectories), then calls collectAgentsFromList()
// to read each directory's markdowns. Anything not in the DB is invisible
// to the dashboard — that's by design; users opt in via the Import UI.
//
// Reads CLAUDE.md presence as the "valid hermit agent" check; if the dir
// has been moved away or is otherwise broken, probe returns null and the
// agent's content is left untouched on the dashboard (last-known state).
//
// Cadence: pushed every ~5 min via index.ts. Markdown files barely churn.

import fs from 'node:fs';
import path from 'node:path';
import { encodedProjectDir } from '@hermit-ui/tmux-driver';

const MAX_TEXT_BYTES = 16 * 1024;       // 16 KB per markdown — anything bigger gets truncated
const SKILL_MAX_BYTES = 64 * 1024;      // SKILL.md gets 64 KB — matches global skills + the 64 KB
                                        // requestEdit/publish ceiling, so a large skill isn't
                                        // truncated before it reaches the detail sheet or the market
const MEMORY_TOPN = 6;                  // top N memory files to mention by name

function safeRead(p: string, maxBytes = MAX_TEXT_BYTES): string | null {
  try {
    const buf = fs.readFileSync(p);
    // Binary sniff: NUL in the first 8KB = not text. isTextFile() is an
    // extension allowlist, but extensionless files are assumed text and a
    // NUL reaching postgres 500s the whole agents sync (22P05).
    if (buf.subarray(0, 8192).includes(0)) return null;
    const text = buf.length <= maxBytes
      ? buf.toString('utf8')
      : buf.subarray(0, maxBytes).toString('utf8') + `\n\n…[truncated ${buf.length - maxBytes} bytes]`;
    return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
  } catch {
    return null;
  }
}

function listSkills(agentDir: string): string[] {
  const skillsDir = path.join(agentDir, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return null as unknown as string[]; // unreachable; lint guard only
  }
}

// All non-SKILL.md files in a skill dir, as { path, content } relative to the
// skill dir — so the dashboard/market can carry a FULL skill (e.g. reshape-agent's
// reshape.sh), not just SKILL.md. Text-only, size-capped, sorted for a stable
// content hash. Skips dotfiles + node_modules.
const SKILL_REF_MAX_FILES = 50;
function listSkillRefs(skillDir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 4 || out.length >= SKILL_REF_MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, depth + 1);
      else if (e.isFile() && rel !== 'SKILL.md' && isTextFile(rel)) {
        const c = safeRead(path.join(dir, e.name), SKILL_MAX_BYTES);
        if (c != null) out.push({ path: rel, content: c });
      }
    }
  };
  walk(skillDir, '', 0);
  out.sort((a, b) => a.path.localeCompare(b.path)); // stable order → deterministic hash
  return out;
}

// Per-skill SKILL.md content + the rest of the skill's file tree (refs), pushed
// alongside skillNames so the detail sheet + market carry the FULL skill, not
// just SKILL.md. Truncated like other markdowns; missing SKILL.md => empty string.
function listSkillDocs(agentDir: string): Array<{ name: string; content: string; refs: Array<{ path: string; content: string }> }> {
  const names = listSkills(agentDir);
  return names.map((name) => {
    const skillDir = path.join(agentDir, '.claude', 'skills', name);
    return {
      name,
      content: safeRead(path.join(skillDir, 'SKILL.md'), SKILL_MAX_BYTES) ?? '',
      refs: listSkillRefs(skillDir),
    };
  });
}

function memorySummary(agentDir: string): string | null {
  const memDir = path.join(agentDir, 'memory');
  if (!fs.existsSync(memDir)) return null;
  let entries: string[];
  try {
    entries = fs
      .readdirSync(memDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name)
      .sort()
      .reverse(); // newest first when names are YYYY-MM-DD.md
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const top = entries.slice(0, MEMORY_TOPN).join(', ');
  const tail = entries.length > MEMORY_TOPN ? ` …+${entries.length - MEMORY_TOPN} more` : '';
  return `${entries.length} files in memory/: ${top}${tail}`;
}

// ── Folder collection: evolution/ (workspace) + memory/ (Claude Code auto-memory
// at ~/.claude/projects/<encoded-cwd>/memory/) for the detail sheet's expandable
// folder view. Walks recursively (newest-first), caps content so a big auto-memory
// dir doesn't bloat the 5-min push; files past the cap — or non-text — are listed
// with content:null so the tree is complete but the payload bounded.
const EVOLUTION_MAX_CONTENT = 60;
const MEMORY_MAX_CONTENT = 40;
const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'sh', 'ts', 'tsx', 'js', 'jsx',
  'cjs', 'mjs', 'py', 'toml', 'csv', 'log', 'env', 'conf', 'ini', 'xml', 'html', 'css',
]);
function isTextFile(rel: string): boolean {
  const base = path.basename(rel);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true; // no extension (README, LICENSE) — assume text
  return TEXT_EXT.has(base.slice(dot + 1).toLowerCase());
}

export interface FileNode {
  path: string; // relative to the folder, e.g. "soul.md" or "reflections/x.md"
  content: string | null; // null = listed but not loaded (past cap or binary)
}

function walkFolder(baseDir: string, maxContent: number): FileNode[] {
  if (!fs.existsSync(baseDir)) return [];
  const found: Array<{ rel: string; mtime: number }> = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 4 || found.length > 500) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip dotfiles / dotdirs
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, depth + 1);
      else if (e.isFile()) {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(dir, e.name)).mtimeMs; } catch {}
        found.push({ rel, mtime });
      }
    }
  };
  walk(baseDir, '', 0);
  found.sort((a, b) => b.mtime - a.mtime); // newest first → recent files keep content
  return found.map((f, i) => ({
    path: f.rel,
    content: i < maxContent && isTextFile(f.rel) ? safeRead(path.join(baseDir, f.rel)) : null,
  }));
}

export interface AgentRow {
  name: string;
  directory: string;
  identityText: string | null;
  userText: string | null;
  agentsText: string | null;
  toolsText: string | null;
  evolutionLessons: string | null;
  evolutionFiles: FileNode[];
  memoryFiles: FileNode[];
  skillNames: string[];
  skills: Array<{ name: string; content: string; refs: Array<{ path: string; content: string }> }>;
  memorySummary: string | null;
}

function probe(agentDir: string, name: string): AgentRow | null {
  if (!fs.existsSync(path.join(agentDir, 'CLAUDE.md'))) return null;
  const skills = listSkillDocs(agentDir);
  return {
    name,
    directory: agentDir,
    identityText: safeRead(path.join(agentDir, 'IDENTITY.md')),
    userText: safeRead(path.join(agentDir, 'USER.md')),
    agentsText: safeRead(path.join(agentDir, 'AGENTS.md')),
    toolsText: safeRead(path.join(agentDir, 'TOOLS.md')),
    evolutionLessons: safeRead(path.join(agentDir, 'evolution', 'lessons.md')),
    evolutionFiles: walkFolder(path.join(agentDir, 'evolution'), EVOLUTION_MAX_CONTENT),
    // memory = Claude Code auto-memory, NOT a workspace folder.
    memoryFiles: walkFolder(path.join(encodedProjectDir(agentDir), 'memory'), MEMORY_MAX_CONTENT),
    skillNames: skills.map((s) => s.name),
    skills,
    memorySummary: memorySummary(agentDir),
  };
}

// Reads each {name, directory} pair given by the dashboard. Entries with a
// null directory are freshly-created agents the gateway hasn't scaffolded
// yet — we skip those. Entries pointing at a missing/broken dir return null
// from probe() and are also skipped (we leave the last-known DB content
// alone rather than blanking it; the row stays visible until explicitly
// deleted).
export function collectAgentsFromList(
  entries: Array<{ name: string; directory: string | null }>,
): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const e of entries) {
    if (!e.directory) continue;
    const r = probe(e.directory, e.name);
    if (r) rows.push(r);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// Single-agent read — useful right after scaffolding so we can push initial
// content without waiting for the next pushAgents tick.
export function readAgent(directory: string, name: string): AgentRow | null {
  return probe(directory, name);
}
