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

const MAX_TEXT_BYTES = 16 * 1024;       // 16 KB per markdown — anything bigger gets truncated
const MEMORY_TOPN = 6;                  // top N memory files to mention by name

function safeRead(p: string, maxBytes = MAX_TEXT_BYTES): string | null {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length <= maxBytes) return buf.toString('utf8');
    return buf.subarray(0, maxBytes).toString('utf8') + `\n\n…[truncated ${buf.length - maxBytes} bytes]`;
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

// Per-skill SKILL.md contents pushed alongside skillNames so the detail sheet
// can render + edit them without a per-skill round trip. Truncated like other
// markdowns; missing SKILL.md => empty string.
function listSkillDocs(agentDir: string): Array<{ name: string; content: string }> {
  const names = listSkills(agentDir);
  return names.map((name) => ({
    name,
    content: safeRead(path.join(agentDir, '.claude', 'skills', name, 'SKILL.md')) ?? '',
  }));
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

export interface AgentRow {
  name: string;
  directory: string;
  identityText: string | null;
  userText: string | null;
  agentsText: string | null;
  toolsText: string | null;
  evolutionLessons: string | null;
  skillNames: string[];
  skills: Array<{ name: string; content: string }>;
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
