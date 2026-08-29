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
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmuxPaneName, parseClaudeSessionIdArg } from '@hermit-ui/tmux-driver';
import { AGENTS_ROOT } from '../config';
import { api } from '../api';
import { sessionActivity, sessionTranscriptPath } from '../pane';
import { runtimeFor } from '../runtime';
import { extractText, hasToolResult, CcEvent } from '../claude-code';

const TAIL_LINES = 500;
const TAIL_TIMEOUT_MS = 4000;

/**
 * How far back the 500-line scan reads. Comfortably more than 500 ordinary
 * transcript lines, and a hard ceiling on what one huge tool result can cost.
 */
const TAIL_WINDOW_BYTES = 1024 * 1024;

/**
 * The byte-bounded fallback window, unchanged from the `tail -c` it replaces:
 * enough to clear recent big lines and reach the last usage record.
 */
const USAGE_WINDOW_BYTES = 8 * 1024 * 1024;
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
  // Process-tree RSS (claude + mcp-stub + any Task children) of this session's
  // pane, in MB. null when the pane is dead or ps is unavailable. Drives the
  // Host-health panel's per-session memory + the reaper's "biggest first" order.
  rssMb: number | null;
  // What the session is doing right now, when its backend can say — the tool and
  // how long it has been on it, the subagent, an API retry. Opaque to the gateway
  // and rendered by the dashboard. Absent for the backends that only know "a child
  // is alive".
  activity?: unknown | null;
}

// One `ps` snapshot per collection → a pid→children + pid→rssKb map, so each
// session's memory is the sum over its pane-pid subtree. RSS over-counts shared
// pages, but it's a fine relative "which session is biggest" signal (the incident
// report estimated per-process RSS the same way). `ps rss` is in KB on macOS+Linux.
interface PsTree {
  children: Map<number, number[]>;
  rssKb: Map<number, number>;
}

async function collectPsTree(): Promise<PsTree> {
  const children = new Map<number, number[]>();
  const rssKb = new Map<number, number>();
  const out = await run('ps', ['-axo', 'pid=,ppid=,rss=']);
  if (out == null) return { children, rssKb };
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]), rss = Number(m[3]);
    rssKb.set(pid, rss);
    const arr = children.get(ppid);
    if (arr) arr.push(pid); else children.set(ppid, [pid]);
  }
  return { children, rssKb };
}

function subtreeRssMb(rootPid: number, tree: PsTree): number {
  let kb = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue; // guard against a pid-reuse cycle
    seen.add(pid);
    kb += tree.rssKb.get(pid) ?? 0;
    for (const c of tree.children.get(pid) ?? []) stack.push(c);
  }
  return Math.round(kb / 1024);
}

// Async exec → stdout, or null on non-zero exit / timeout / buffer overflow.
function run(cmd: string, args: string[], timeoutMs = TAIL_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUF }, (err, stdout) => {
        resolve(err ? null : stdout ?? '');
      });
    } catch {
      // execFile can throw SYNCHRONOUSLY under fd pressure (EBADF / EMFILE during
      // spawn setup) — not only deliver the error to the callback. Without this
      // guard that throw rejects the promise, propagates through the Promise.all
      // in collectSessionSnapshots, and stales EVERY session's snapshot for the
      // whole tick (status + queue blank fleet-wide). Treat it like any other
      // probe failure: null.
      resolve(null);
    }
  });
}

// `tmux has-session` exits 0 iff the pane exists.
async function paneAlive(sessionId: string): Promise<boolean> {
  return (await run('tmux', ['has-session', '-t', `=${tmuxPaneName(sessionId)}`], TMUX_TIMEOUT_MS)) !== null;
}

async function tmuxPanePid(sessionId: string): Promise<number | null> {
  // `display -p -t =session '#{pane_pid}'` resolves the target as a CLIENT and
  // returns EMPTY when no client is attached (the gateway never attaches) — so
  // this silently yielded null for every session. `list-panes` resolves the
  // session directly and reliably prints the pane pid.
  const out = await run('tmux', ['list-panes', '-t', `=${tmuxPaneName(sessionId)}`, '-F', '#{pane_pid}'], TMUX_TIMEOUT_MS);
  if (out == null) return null;
  const first = out.split('\n').map((l) => l.trim()).find(Boolean);
  const n = Number(first);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The working-vs-idle verdict (sessionActivity — freshness / tool-in-flight / pane
// marker / hook, composed into one answer) lives in ../pane, shared with the chat
// dispatch gate + cron-runner so every caller reaches the same verdict.

// The transcript-path derivation is shared with pane.ts (sessionTranscriptPath) —
// the single source of truth for the ~/.claude/projects layout. The snapshot adds
// the existence check on top: a pruned / not-yet-created transcript reports as null.
function transcriptPath(claudeSessionId: string, agentDir: string): string | null {
  const p = sessionTranscriptPath(claudeSessionId, agentDir);
  return p && fs.existsSync(p) ? p : null;
}

/**
 * The last `maxBytes` of a file, read in this process.
 *
 * Every transcript read on this tick used to be a `tail` CHILD PROCESS, one per
 * session. Sampled on a live gateway: 12 of them at the same instant, every 8
 * seconds — around 130,000 spawns a day to read the end of a file Node can open
 * itself. It also fed the exact pressure `run()` has a synchronous-throw guard
 * for: fd exhaustion during spawn setup, whose failure mode is every session's
 * snapshot going blank for a tick.
 *
 * Async rather than the sync form used elsewhere in this file: the window is up
 * to 8 MB on the fallback path, and this runs for every session on a fixed tick.
 * Blocking the loop for that is a worse trade than the one it replaces.
 *
 * `whole` says the window reached the start of the file, which is how the caller
 * knows whether its first line is real or was cut in half by the window.
 */
export async function readTailBytes(
  p: string,
  maxBytes: number,
): Promise<{ text: string; whole: boolean } | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(p, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    if (len === 0) return { text: '', whole: true };
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return { text: buf.toString('utf8'), whole: len === size };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * The newest `n` lines, from a bounded window at the end of the file.
 *
 * Byte-bounded where `tail -n` was line-bounded, and that is a deliberate
 * change: a turn that emits a few hundred-megabyte tool results would make
 * `tail -n 500` read hundreds of megabytes to hand back 500 lines. The window
 * caps that. When it does not reach far enough back to hold n lines the caller
 * gets the newest ones it does hold, which is what every scan here wants, and
 * the byte-bounded fallback below still covers the case where that misses the
 * usage record.
 */
export async function tailLines(jsonl: string, n = TAIL_LINES): Promise<string[]> {
  const got = await readTailBytes(jsonl, TAIL_WINDOW_BYTES);
  if (!got) return [];
  const lines = got.text.split('\n');
  // A window that stopped short of the start cut its first line in half.
  if (!got.whole) lines.shift();
  return lines.filter(Boolean).slice(-n);
}

// Most-recent context size, robust to very long turns. The 500-line window can
// miss the last assistant `usage` when a turn emits hundreds of tool lines that
// push it out of view. We read a byte-bounded tail (NOT line-bounded): `tail -c`
// reads a fixed window from the end, fast regardless of line size; 8 MB clears
// recent big lines to reach the last usage. Only runs when the main scan came
// up empty.
async function lastUsageTokens(jsonl: string): Promise<{ contextTokens: number; outputTokens: number } | null> {
  const got = await readTailBytes(jsonl, USAGE_WINDOW_BYTES);
  if (got == null) return null;
  const lines = got.text.split('\n');
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

// extractText / hasToolResult / hasToolUse now live in ../claude-code (shared).

// transcriptToolRunning (the retroactive "tool in flight" signal) moved to ../pane in
// P1-5 — it's now composed inside sessionActivity so every caller shares one verdict.

/**
 * Runtime state for a non-tmux session.
 *
 * The main probe derives everything from a tmux pane plus Claude Code's JSONL,
 * and a pi session has neither — which is why pi sessions showed a blank status
 * light and no context until this existed. The numbers come from the runtime
 * instead, and `contextTokens` is deliberately last-turn so the dashboard's
 * context bar means the same thing for both backends.
 */
export async function probeRuntime(
  runtime: NonNullable<ReturnType<typeof runtimeFor>>,
  sessionId: string,
  // agentName / agentDirectory are unread here — this probe gets everything from
  // the runtime, not the agent dir. Kept so all three probes take the same
  // arguments and the dispatcher below can hand them the same tuple.
  agentName: string,
  agentDirectory: string | null,
  claudeSessionId: string | null,
): Promise<SessionSnapshot> {
  const base: SessionSnapshot = {
    sessionId, pid: null, alive: false, state: null,
    contextTokens: null, outputTokens: null, lastActivity: null,
    transcriptPath: null, lastUserPrompt: null, lastAssistantText: null,
    rssMb: null,
  };

  // A handle only exists once the session has been driven at least once; an
  // idle-but-open session legitimately has none, and that is "not alive"
  // rather than an error.
  const handle = { sessionId, externalSessionId: claudeSessionId ?? '' };
  try {
    const working = await runtime.isWorking(handle);
    const usage = await runtime.usage(handle);
    if (usage === null && !working) {
      // Some runtimes can recover durable token accounting without creating a
      // live process/handle. Preserve alive=false here: usage recovery must not
      // wake a hibernated session or claim an idle process exists.
      const stored = await runtime.storedUsage?.(handle) ?? null;
      if (!stored) return base;
      return {
        ...base,
        contextTokens: stored.contextTokens,
        outputTokens: stored.outputTokens,
      };
    }
    return {
      ...base,
      alive: true,
      state: working ? 'working' : 'idle',
      contextTokens: usage?.contextTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    };
  } catch {
    return base;
  }
}

async function probe(
  sessionId: string,
  agentName: string,
  agentDirectory: string | null,
  claudeSessionId: string | null,
  psTree: PsTree,
): Promise<SessionSnapshot> {
  // DB-leader: prefer the agent's stored directory (works for imported agents
  // whose path lives outside AGENTS_ROOT). Fall back to the old AGENTS_ROOT
  // guess so a freshly-created agent whose directory hasn't been written back
  // yet still gets probed.
  const agentDir = agentDirectory ?? path.join(AGENTS_ROOT, agentName);
  const empty = {
    sessionId, pid: null, contextTokens: null, outputTokens: null,
    lastActivity: null, transcriptPath: null, lastUserPrompt: null,
    lastAssistantText: null, rssMb: null,
  };

  const alive = await paneAlive(sessionId);
  if (!alive) return { ...empty, alive: false, state: null };

  const tp = claudeSessionId ? transcriptPath(claudeSessionId, agentDir) : null;

  // Read the transcript tail (also used below for usage/last-text parsing), then hand
  // it to the ONE working-detection verdict — sessionActivity folds the retroactive
  // "tool in flight" signal (a long quiet tool call on a NARROW pane, where Claude Code
  // truncates "esc to interrupt" off the mode line and the transcript mtime has gone
  // stale) into the same verdict every gate uses, instead of it being bolted on here.
  const [pid, lines] = await Promise.all([
    tmuxPanePid(sessionId),
    tp ? tailLines(tp) : Promise.resolve<string[]>([]),
  ]);
  const { working } = await sessionActivity(sessionId, {
    transcriptPath: tp, agentDir, claudeSessionId, transcriptLines: lines,
  });
  const state = working ? 'working' : 'idle';
  const rssMb = pid != null ? subtreeRssMb(pid, psTree) : null;

  if (!tp) return { ...empty, alive, pid, state: 'starting', rssMb };

  const t = await readTranscriptState(tp, lines);
  return {
    sessionId, pid, alive, state,
    contextTokens: t.contextTokens,
    outputTokens: t.outputTokens,
    lastActivity: t.lastActivity,
    transcriptPath: tp,
    lastUserPrompt: t.lastUserPrompt,
    lastAssistantText: t.lastAssistantText,
    rssMb,
  };
}

/**
 * Everything a snapshot reads out of the transcript itself.
 *
 * Split out of `probe` because it is backend-INDEPENDENT: the claude-sdk
 * backend writes the same `~/.claude/projects/<cwd>/<uuid>.jsonl` the pane does,
 * so a session driven through the SDK deserves the same context bar, the same
 * last-message previews and the same activity clock rather than the reduced
 * runtime-only view the child-process backends get. Only liveness differs, and
 * that is the caller's job.
 */
type TranscriptState = {
  lastActivity: string | null;
  contextTokens: number | null;
  outputTokens: number | null;
  lastUserPrompt: string | null;
  lastAssistantText: string | null;
};

async function readTranscriptState(tp: string, lines: string[]): Promise<TranscriptState> {
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
    if (contextTokens == null && ev.type === CcEvent.assistant && ev.message?.usage) {
      const u = ev.message.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      // Skip a zeroed usage rather than reporting it. Claude Code answers
      // `/context`, `/status` and friends locally and writes them to the
      // transcript as assistant records whose usage is all zeros — and this
      // scan is newest-first, so one of those at the tail used to pin the
      // context bar to 0 for a session that is nowhere near empty. No real
      // model call has a zero prompt.
      if (ctx > 0) { contextTokens = ctx; outputTokens = u.output_tokens || 0; }
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
      const post = ev.compactMetadata?.postTokens ?? ev.compact_metadata?.post_tokens;
      if (typeof post === 'number' && post > 0) contextTokens = post;
    }
    if (lastAssistant == null && ev.type === CcEvent.assistant && ev.message?.content) {
      const t = extractText(ev.message.content).trim();
      if (t) lastAssistant = t.slice(0, PROMPT_MAX_CHARS);
    } else if (lastUser == null && ev.type === CcEvent.user && ev.message?.content) {
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
    lastActivity: lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null,
    contextTokens,
    outputTokens,
    lastUserPrompt: lastUser,
    lastAssistantText: lastAssistant,
  };
}

/**
 * Is the durable-usage fallback worth reading?
 *
 * Exported and pure because the answer decides whether an 8-second tick touches
 * the filesystem N extra times, and "we only call it when we need it" is the
 * kind of claim that quietly stops being true. Returns false whenever the
 * numbers are already in hand, which is the overwhelmingly common case: the
 * transcript tail the collector reads anyway carries the same `usage` record.
 *
 * Context and output tokens come off the SAME transcript event, so they are
 * both present or both absent — but this asks about each of them rather than
 * assuming that, so the fallback still fires if the two ever come apart. That
 * keeps the snapshot byte-identical to the unconditional version it replaces.
 */
export function needsStoredUsage(
  alive: boolean,
  t: { contextTokens: number | null; outputTokens: number | null },
  usage: { contextTokens: number | null; outputTokens: number | null } | null,
): boolean {
  // A live session has a handle, and the handle's own usage outranks the disk.
  if (alive) return false;
  return (t.contextTokens ?? usage?.contextTokens ?? null) === null
    || (t.outputTokens ?? usage?.outputTokens ?? null) === null;
}

/**
 * Snapshot for a claude-sdk session.
 *
 * The middle ground between the two probes that already exist, and the reason
 * it is worth its own function: liveness comes from the runtime (there is no
 * pane to capture and no mode line to scrape), but EVERYTHING else comes from
 * the transcript, exactly as it does for a pane. A session driven through the
 * SDK therefore shows the same context bar, message previews and activity clock
 * it showed on tmux — the child-process backends' reduced view would have been
 * a visible downgrade for what is meant to be the same product.
 */
export async function probeClaudeSdk(
  runtime: NonNullable<ReturnType<typeof runtimeFor>>,
  sessionId: string,
  agentName: string,
  agentDirectory: string | null,
  claudeSessionId: string | null,
  psTree: PsTree,
  pidByUuid: Map<string, number>,
): Promise<SessionSnapshot> {
  const agentDir = agentDirectory ?? path.join(AGENTS_ROOT, agentName);
  const base: SessionSnapshot = {
    sessionId, pid: null, alive: false, state: null,
    contextTokens: null, outputTokens: null, lastActivity: null,
    transcriptPath: null, lastUserPrompt: null, lastAssistantText: null,
    rssMb: null, activity: null,
  };

  const handle = { sessionId, externalSessionId: claudeSessionId ?? '' };
  const usage = await runtime.usage(handle);
  // Read it even when idle: `null` is the value that CLEARS a stale chip, so
  // skipping the call would leave the last thing the session did on screen.
  const activity = (await runtime.activity?.(handle).catch(() => null)) ?? null;
  // usage() returns null exactly when there is no live handle — an idle-but-open
  // or hibernated session, which is "not alive" rather than an error.
  const alive = usage !== null;
  const working = alive ? await runtime.isWorking(handle) : false;

  const tp = claudeSessionId ? transcriptPath(claudeSessionId, agentDir) : null;
  if (!tp) {
    return { ...base, alive, state: alive ? 'starting' : null };
  }

  const lines = await tailLines(tp);
  const t = await readTranscriptState(tp, lines);
  // Ask for stored usage only when the two cheaper sources came up empty, and
  // hand over the transcript path when we do. Both halves matter: the call used
  // to run for every non-alive session on every 8s tick and trigger a readdir of
  // the agent root plus up to one open per agent (48 here) — to produce the LAST
  // of three fallbacks, which the tail above had almost always already supplied.
  // It no longer runs at all in that case, and when it does it reads one known
  // file. The two were parallel before; serialising them costs nothing, because
  // the second one now almost never happens.
  const stored = needsStoredUsage(alive, t, usage)
    ? await (runtime.storedUsage?.(handle, tp) ?? Promise.resolve(null))
    : null;

  // The SDK child is a gateway subprocess, so its RSS is findable the same way
  // the pane's was — by the session uuid on its argv. Resource governance ranks
  // on this; leaving it null would make every SDK session look free.
  const pid = claudeSessionId ? pidByUuid.get(claudeSessionId) ?? null : null;

  return {
    ...base,
    alive,
    pid,
    state: alive ? (working ? 'working' : 'idle') : null,
    contextTokens: t.contextTokens ?? usage?.contextTokens ?? stored?.contextTokens ?? null,
    outputTokens: t.outputTokens ?? usage?.outputTokens ?? stored?.outputTokens ?? null,
    lastActivity: t.lastActivity,
    transcriptPath: tp,
    lastUserPrompt: t.lastUserPrompt,
    lastAssistantText: t.lastAssistantText,
    rssMb: pid != null ? subtreeRssMb(pid, psTree) : null,
    activity,
  };
}

/**
 * claude session uuid → pid, for the Claude Code processes this gateway spawned
 * through the SDK.
 *
 * The SDK puts the session on the child's command line (`--session-id` for a
 * fresh one, `--resume` for a woken one), which is the same ground truth the
 * pane path reads with `paneClaudeSessionId`. One `ps` per tick for the whole
 * fleet, not one per session.
 */
async function collectSdkPids(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const out = await run('ps', ['-axww', '-o', 'pid=,command=']);
  if (out == null) return map;
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    if (!/\bclaude\b/.test(m[2])) continue;
    const uuid = parseClaudeSessionIdArg(m[2]);
    if (uuid && !map.has(uuid)) map.set(uuid, Number(m[1]));
  }
  return map;
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
  // slowest single probe, not the sum. allSettled, NOT all: a single probe that
  // rejects (e.g. a transient spawn EBADF under fd pressure that escapes the
  // guards) must not blank EVERY session's status for the tick — drop only the
  // one that failed and push the rest, so the fleet's status degrades by one
  // session instead of going dark.
  // One ps snapshot for the whole tick → every session's pane-subtree RSS is
  // summed from the same map (no per-session ps fork).
  const psTree = await collectPsTree();
  // Only paid for when a claude-sdk session is actually present.
  const needSdkPids = pending.sessions.some((s) => s.runtime === 'claude-sdk');
  const sdkPids = needSdkPids ? await collectSdkPids() : new Map<string, number>();
  const settled = await Promise.allSettled(
    pending.sessions.map((s) => {
      // The MODE is not optional here. It is what picks the engine, and each
      // engine keeps its own live-handle map — so probing an omp session with
      // pi's runtime finds no handle, reads no usage, and the session shows a
      // blank context bar forever while its child is perfectly healthy.
      const runtime = runtimeFor(s.runtime, s.runtimeMode);
      if (runtime?.kind === 'claude-sdk') {
        return probeClaudeSdk(
          runtime, s.id, s.agentName, s.agentDirectory, s.claudeSessionId, psTree, sdkPids,
        );
      }
      return runtime
        ? probeRuntime(runtime, s.id, s.agentName, s.agentDirectory, s.claudeSessionId)
        : probe(s.id, s.agentName, s.agentDirectory, s.claudeSessionId, psTree);
    }),
  );
  const out: SessionSnapshot[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') out.push(r.value);
    else console.error('[session-snapshots] probe failed:', r.reason);
  }
  return withQueued(out, pending.messages);
}

/**
 * A session holding a message it has not handed to the model yet is WORKING.
 *
 * No probe can see this, because it is not a fact about the model — it is a fact
 * about the gateway's own queue. `chat.send` writes the row; `deliverMessages`
 * picks it up on the next 2s chat tick, later still if a turn is already
 * running. In between, every runtime honestly answers "no turn in flight", the
 * snapshot writes `idle` with a fresh `snapshotAt`, and the chat page reads that
 * pair as "the gateway looked after my message and nothing is happening" — so
 * the optimistic yellow it had shown since the keypress is withdrawn, and the
 * status reads ready until the turn actually starts. That is the working →
 * ready → working flicker, and this is where it originates.
 *
 * `pending.messages` is the undelivered user queue and the collector already has
 * it — the same poll that discovers which sessions to probe returns it. So this
 * costs one Set build per tick and no query at all.
 *
 * Only 'idle' is lifted. A dead or still-booting session keeps what the probe
 * said: 'starting' is more informative than 'working', and a null state means
 * nothing is there to run the message, which is the truth worth showing.
 */
export function withQueued(
  snapshots: SessionSnapshot[],
  undelivered: Array<{ sessionId: string }>,
): SessionSnapshot[] {
  if (undelivered.length === 0) return snapshots;
  const waiting = new Set(undelivered.map((m) => m.sessionId));
  if (waiting.size === 0) return snapshots;
  return snapshots.map((s) =>
    s.state === 'idle' && waiting.has(s.sessionId) ? { ...s, state: 'working' } : s,
  );
}
