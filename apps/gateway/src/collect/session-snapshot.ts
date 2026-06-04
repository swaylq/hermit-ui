// collect/session-snapshot.ts — runtime state per ChatSession.
//
// For each active ChatSession the dashboard tracks, derive the per-session
// runtime metrics (alive, pid, working/idle, contextTokens, last user/asst
// snippet, etc.) and push them via /api/sync/session-snapshot.
//
// Active sessions are discovered via api.pollChatPending (which already returns
// `closedAt: null` sessions for the chat-tick).
//
// Two hard-won implementation rules baked in below:
//   1. Everything shells out ASYNC + the 8 session probes run CONCURRENTLY
//      (Promise.all). The old spawnSync version blocked the single-threaded
//      gateway event loop for the whole collection (~8s with many panes),
//      starving chat delivery and other ticks. async exec means the snapshot
//      wall-time ≈ the slowest single probe, and the loop stays responsive.
//   2. `maxBuffer` is bumped to 32 MB. The Node default is 1 MB; asst transcripts
//      interleave very large single lines (base64 images, big tool outputs — one
//      was 316 KB), so `tail -n 500` / `tail -c 8M` overflow 1 MB and the child
//      errors out → empty → null ctx. THAT (not a timeout) is why busy agents
//      showed ctx "—" while small idle test agents didn't.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { encodedProjectDir, tmuxPaneName } from '@hermit-ui/tmux-driver';
import { AGENTS_ROOT } from '../config';
import { api } from '../api';
import { paneIsWorking } from '../pane';

const TAIL_LINES = 500;
const TAIL_TIMEOUT_MS = 4000;
const TMUX_TIMEOUT_MS = 2000;
const MAX_BUF = 32 * 1024 * 1024; // big-line transcripts blow the 1 MB default
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
  // Whatever JSON the agent's cron skill left in <AGENT_DIR>/.loop-state.json.
  // Opaque to the gateway — dashboard renders it.
  loopState: unknown | null;
}

// Async exec → stdout, or null on non-zero exit / timeout / buffer overflow.
function run(cmd: string, args: string[], timeoutMs = TAIL_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUF }, (err, stdout) => {
      resolve(err ? null : stdout ?? '');
    });
  });
}

// `tmux has-session` exits 0 iff the pane exists.
async function paneAlive(sessionId: string): Promise<boolean> {
  return (await run('tmux', ['has-session', '-t', `=${tmuxPaneName(sessionId)}`], TMUX_TIMEOUT_MS)) !== null;
}

async function tmuxPanePid(sessionId: string): Promise<number | null> {
  const out = await run('tmux', ['display', '-p', '-t', `=${tmuxPaneName(sessionId)}`, '#{pane_pid}'], TMUX_TIMEOUT_MS);
  if (out == null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

// paneIsWorking (working-vs-idle via the "esc to interrupt" pane marker) now
// lives in ../pane — shared with the chat dispatch gate + cron-runner.

function transcriptPath(claudeSessionId: string, agentDir: string): string | null {
  const p = path.join(encodedProjectDir(agentDir), `${claudeSessionId}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

async function tailLines(jsonl: string, n = TAIL_LINES): Promise<string[]> {
  const out = await run('tail', ['-n', String(n), jsonl]);
  return out == null ? [] : out.split('\n').filter(Boolean);
}

// Most-recent context size, robust to very long turns. The 500-line window can
// miss the last assistant `usage` when a turn emits hundreds of tool lines that
// push it out of view. We read a byte-bounded tail (NOT line-bounded): `tail -c`
// reads a fixed window from the end, fast regardless of line size; 8 MB clears
// recent big lines to reach the last usage. Only runs when the main scan came
// up empty.
async function lastUsageTokens(jsonl: string): Promise<{ contextTokens: number; outputTokens: number } | null> {
  const out = await run('tail', ['-c', String(8 * 1024 * 1024), jsonl]);
  if (out == null) return null;
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // A compact boundary is the authoritative post-compact size. Newest-first,
    // so if it's more recent than any usage line it wins (matches the main scan).
    if (line.includes('"compact_boundary"')) {
      try {
        const post = JSON.parse(line)?.compactMetadata?.postTokens;
        if (typeof post === 'number' && post > 0) return { contextTokens: post, outputTokens: 0 };
      } catch { /* keep scanning older matches */ }
    }
    if (!line.includes('"output_tokens"')) continue;
    try {
      const u = JSON.parse(line)?.message?.usage;
      if (u) {
        return {
          contextTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
          outputTokens: u.output_tokens || 0,
        };
      }
    } catch { /* keep scanning older matches */ }
  }
  return null;
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

// Read the per-agent loop / scheduled-task state file the cron skill maintains.
// Absent / unparseable returns null (dashboard hides the chip). Lives at the
// agent dir level — multiple chat sessions on the same agent see the union.
function readLoopState(agentDir: string): unknown | null {
  try {
    const p = path.join(agentDir, '.loop-state.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function probe(
  sessionId: string,
  agentName: string,
  agentDirectory: string | null,
  claudeSessionId: string | null,
): Promise<SessionSnapshot> {
  // DB-leader: prefer the agent's stored directory (works for imported agents
  // whose path lives outside AGENTS_ROOT). Fall back to the old AGENTS_ROOT
  // guess so a freshly-created agent whose directory hasn't been written back
  // yet still gets probed.
  const agentDir = agentDirectory ?? path.join(AGENTS_ROOT, agentName);
  const loopState = readLoopState(agentDir);
  const empty = {
    sessionId, pid: null, contextTokens: null, outputTokens: null,
    lastActivity: null, transcriptPath: null, lastUserPrompt: null,
    lastAssistantText: null, loopState,
  };

  const alive = await paneAlive(sessionId);
  if (!alive) return { ...empty, alive: false, state: null };

  const tp = claudeSessionId ? transcriptPath(claudeSessionId, agentDir) : null;

  // Independent shell-outs run concurrently — none blocks the event loop.
  const [pid, working, lines] = await Promise.all([
    tmuxPanePid(sessionId),
    paneIsWorking(sessionId),
    tp ? tailLines(tp) : Promise.resolve<string[]>([]),
  ]);
  const state = working ? 'working' : 'idle';

  if (!tp) return { ...empty, alive, pid, state: 'starting' };

  let lastActivityMs = 0;
  let contextTokens: number | null = null;
  let outputTokens: number | null = null;
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;

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
    // A compact (manual /compact or auto-compact when the window fills) resets
    // the context. Claude Code records the post-compact size on the boundary
    // event as compactMetadata.postTokens. Without this branch the newest-first
    // scan walks straight past the boundary to the last *pre-compact* assistant
    // usage (the big number) and reports it until the next turn writes a fresh
    // usage — so ctx stays stale for the whole gap right after a compact. Same
    // `contextTokens == null` guard + newest-first means whichever is more
    // recent wins: a post-compact turn's usage, or the boundary itself.
    if (contextTokens == null && ev.type === 'system' && ev.subtype === 'compact_boundary') {
      const post = ev.compactMetadata?.postTokens;
      if (typeof post === 'number' && post > 0) contextTokens = post;
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

  // ctx fallback: a long current turn can bury the last usage past the line
  // window — read it from a byte-bounded tail so the percentage is available.
  if (contextTokens == null) {
    const u = await lastUsageTokens(tp);
    if (u) { contextTokens = u.contextTokens; outputTokens = u.outputTokens; }
  }

  return {
    sessionId,
    pid,
    alive,
    state,
    contextTokens,
    outputTokens,
    lastActivity: lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null,
    transcriptPath: tp,
    lastUserPrompt: lastUser,
    lastAssistantText: lastAssistant,
    loopState,
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
  // All session probes run concurrently — the collection is as fast as the
  // slowest single probe, not the sum.
  return Promise.all(
    pending.sessions.map((s) => probe(s.id, s.agentName, s.agentDirectory, s.claudeSessionId)),
  );
}
