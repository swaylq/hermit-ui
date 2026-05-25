// collect/agents.ts — STATIC metadata reader.
//
// Walks AGENTS_ROOT, finds every directory with a CLAUDE.md (the hermit
// scaffold marker), reads its IDENTITY/USER/AGENTS/TOOLS markdowns + the
// evolution lesson log + the skill folder list + a memory summary. No pid
// probing, no JSONL tailing, no lsof — all runtime state lives on
// ChatSession now (see collect/session-snapshot.ts).
//
// Cadence: pushed every ~5 min via index.ts. Markdown files barely churn.

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_ROOT } from '../config';

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
  memorySummary: string | null;
}

function probe(agentDir: string, name: string): AgentRow | null {
  if (!fs.existsSync(path.join(agentDir, 'CLAUDE.md'))) return null;
  return {
    name,
    directory: agentDir,
    identityText: safeRead(path.join(agentDir, 'IDENTITY.md')),
    userText: safeRead(path.join(agentDir, 'USER.md')),
    agentsText: safeRead(path.join(agentDir, 'AGENTS.md')),
    toolsText: safeRead(path.join(agentDir, 'TOOLS.md')),
    evolutionLessons: safeRead(path.join(agentDir, 'evolution', 'lessons.md')),
    skillNames: listSkills(agentDir),
    memorySummary: memorySummary(agentDir),
  };
}

export function collectAgents(): AgentRow[] {
  if (!fs.existsSync(AGENTS_ROOT)) return [];
  return fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => probe(path.join(AGENTS_ROOT, d.name), d.name))
    .filter((r): r is AgentRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
