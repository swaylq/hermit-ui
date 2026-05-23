// Pre-aggregate per-agent JSONL transcript tails.
//
// For each agent under AGENTS_ROOT, find the newest claude transcript jsonl
// in ~/.claude/projects/<encoded-cwd>/, tail the last N lines, and pluck the
// most-recent USER prompt (plain text, not a tool_result echo) plus the most-
// recent ASSISTANT text. Posted to dashboard via /api/sync/agent-snapshot so
// the agent-detail sheet never shells out on the VPS.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodedProjectDir } from '@hermit-ui/tmux-driver';
import { AGENTS_ROOT } from '../config';

const TAIL_LINES = 500;
const TAIL_TIMEOUT_MS = 1500;
const PROMPT_MAX_CHARS = 600;

export interface AgentSnapshot {
  name: string;
  lastUserPrompt: string | null;
  lastAssistantText: string | null;
}

function newestJsonl(projectDir: string): string | null {
  if (!fs.existsSync(projectDir)) return null;
  let best: { p: string; mtimeMs: number } | null = null;
  for (const ent of fs.readdirSync(projectDir)) {
    if (!ent.endsWith('.jsonl')) continue;
    const full = path.join(projectDir, ent);
    try {
      const st = fs.statSync(full);
      if (!best || st.mtimeMs > best.mtimeMs) best = { p: full, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return best?.p ?? null;
}

function tail(jsonl: string, n = TAIL_LINES): string[] {
  // Spawn tail rather than readFileSync so a multi-MB transcript doesn't pull
  // the entire history into memory just to peek at the last few exchanges.
  const r = spawnSync('tail', ['-n', String(n), jsonl], {
    encoding: 'utf8',
    timeout: TAIL_TIMEOUT_MS,
  });
  if (r.status !== 0) return [];
  return (r.stdout || '').split('\n').filter(Boolean);
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Filter out tool_result blocks — those are claude's mid-turn echoes of tool
  // output back to itself, not what the human typed. Keep only `text` blocks.
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
}

export function snapshotAgent(agentName: string, agentDir: string): AgentSnapshot {
  const projectDir = encodedProjectDir(agentDir);
  const jsonl = newestJsonl(projectDir);
  if (!jsonl) {
    return { name: agentName, lastUserPrompt: null, lastAssistantText: null };
  }

  const lines = tail(jsonl);
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;

  // Iterate newest → oldest so we find the most-recent matching events first.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastUser != null && lastAssistant != null) break;
    const line = lines[i];
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;

    if (lastAssistant == null && ev.type === 'assistant' && ev.message?.content) {
      const t = extractAssistantText(ev.message.content).trim();
      if (t) lastAssistant = t.slice(0, PROMPT_MAX_CHARS);
    } else if (lastUser == null && ev.type === 'user' && ev.message?.content) {
      // Skip user events that are pure tool_result echoes (claude feeding tool
      // output back to itself); those are noise from the human's POV.
      if (hasToolResult(ev.message.content)) continue;
      const t = extractUserText(ev.message.content).trim();
      if (t) lastUser = t.slice(0, PROMPT_MAX_CHARS);
    }
  }

  return { name: agentName, lastUserPrompt: lastUser, lastAssistantText: lastAssistant };
}

export function collectAgentSnapshots(): AgentSnapshot[] {
  if (!fs.existsSync(AGENTS_ROOT)) return [];
  const out: AgentSnapshot[] = [];
  for (const ent of fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const agentDir = path.join(AGENTS_ROOT, ent.name);
    // Skip non-agent directories (no CLAUDE.md = not a hermit agent).
    if (!fs.existsSync(path.join(agentDir, 'CLAUDE.md'))) continue;
    out.push(snapshotAgent(ent.name, agentDir));
  }
  return out;
}
