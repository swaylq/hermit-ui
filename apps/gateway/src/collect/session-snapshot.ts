// collect/session-snapshot.ts — runtime state per ChatSession.
//
// For each active ChatSession the dashboard tracks, derive the per-session
// runtime metrics (alive, pid, contextTokens, last user/asst snippet, etc.)
// and push them via /api/sync/session-snapshot.
//
// Active sessions are discovered via api.pollChatPending (which already
// returns `closedAt: null` sessions for the chat-tick); we read its
// `sessions` array and synthesize a snapshot per session.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodedProjectDir, tmuxSessionExists, tmuxPaneName } from '@hermit-ui/tmux-driver';
import { AGENTS_ROOT } from '../config';
import { api } from '../api';

const TAIL_LINES = 500;
const TAIL_TIMEOUT_MS = 1500;
const PROMPT_MAX_CHARS = 600;

export interface SessionSnapshot {
  sessionId: string;
  pid: number | null;
  alive: boolean;
  state: string | null;
  contextTokens: number | null;
  outputTokens: number | null;
  lastActivity: string | null;
  transcriptPath: string | null;
  lastUserPrompt: string | null;
  lastAssistantText: string | null;
}

function tmuxPanePid(sessionId: string): number | null {
  const name = tmuxPaneName(sessionId);
  const r = spawnSync('tmux', ['display', '-p', '-t', `=${name}`, '#{pane_pid}'], {
    encoding: 'utf8',
    timeout: 1500,
  });
  if (r.status !== 0) return null;
  const n = Number((r.stdout || '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function transcriptPath(claudeSessionId: string, agentDir: string): string | null {
  const projectDir = encodedProjectDir(agentDir);
  const p = path.join(projectDir, `${claudeSessionId}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

function tail(jsonl: string, n = TAIL_LINES): string[] {
  const r = spawnSync('tail', ['-n', String(n), jsonl], { encoding: 'utf8', timeout: TAIL_TIMEOUT_MS });
  if (r.status !== 0) return [];
  return (r.stdout || '').split('\n').filter(Boolean);
}

function extractText(content: unknown): string {
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

function probe(sessionId: string, agentName: string, claudeSessionId: string | null): SessionSnapshot {
  const agentDir = path.join(AGENTS_ROOT, agentName);
  const alive = tmuxSessionExists(sessionId);
  const pid = alive ? tmuxPanePid(sessionId) : null;

  if (!claudeSessionId) {
    return {
      sessionId, pid, alive, state: alive ? 'starting' : null,
      contextTokens: null, outputTokens: null,
      lastActivity: null, transcriptPath: null,
      lastUserPrompt: null, lastAssistantText: null,
    };
  }

  const tp = transcriptPath(claudeSessionId, agentDir);
  if (!tp) {
    return {
      sessionId, pid, alive, state: alive ? 'starting' : null,
      contextTokens: null, outputTokens: null,
      lastActivity: null, transcriptPath: null,
      lastUserPrompt: null, lastAssistantText: null,
    };
  }

  let lastActivityMs = 0;
  let contextTokens: number | null = null;
  let outputTokens: number | null = null;
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;

  const lines = tail(tp);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastUser != null && lastAssistant != null && contextTokens != null) break;
    let ev: any;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.timestamp && typeof ev.timestamp === 'string') {
      const t = Date.parse(ev.timestamp);
      if (Number.isFinite(t) && t > lastActivityMs) lastActivityMs = t;
    }
    if (contextTokens == null && ev.type === 'assistant' && ev.message?.usage) {
      const u = ev.message.usage;
      contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      outputTokens = u.output_tokens || 0;
    }
    if (lastAssistant == null && ev.type === 'assistant' && ev.message?.content) {
      const t = extractText(ev.message.content).trim();
      if (t) lastAssistant = t.slice(0, PROMPT_MAX_CHARS);
    } else if (lastUser == null && ev.type === 'user' && ev.message?.content) {
      if (hasToolResult(ev.message.content)) continue;
      const t = extractText(ev.message.content).trim();
      if (t) lastUser = t.slice(0, PROMPT_MAX_CHARS);
    }
  }

  return {
    sessionId,
    pid,
    alive,
    state: !alive
      ? null
      : lastActivityMs > 0 && Date.now() - lastActivityMs < 30_000
        ? 'running'
        : 'idle',
    contextTokens,
    outputTokens,
    lastActivity: lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null,
    transcriptPath: tp,
    lastUserPrompt: lastUser,
    lastAssistantText: lastAssistant,
  };
}

export async function collectSessionSnapshots(): Promise<SessionSnapshot[]> {
  let pending: Awaited<ReturnType<typeof api.pollChatPending>>;
  try {
    pending = await api.pollChatPending();
  } catch (e) {
    console.error('[session-snapshots] poll failed:', e);
    return [];
  }
  return pending.sessions.map((s) => probe(s.id, s.agentName, s.claudeSessionId));
}
