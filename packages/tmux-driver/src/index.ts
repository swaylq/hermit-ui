// @hermit-ui/tmux-driver
//
// Long-lived tmux session per ChatSession. Each pane runs an interactive
// `claude` — keeps quota in the Interactive billing bucket (see L1) and
// gives us slash commands, sub-agents, /compact for free.
//
// Public surface:
//   ensureSession    — spawn pane if missing, idempotent
//   sendKeys         — push user text into the pane + submit
//   sendInterrupt    — Escape key (claude's mid-turn interrupt)
//   kill             — graceful /exit then SIGKILL after grace period
//   getClaudeSessionUuid — find the JSONL transcript path
//   watchTranscript  — tail -F a JSONL, emit parsed events
//
// Structured output comes from `~/.claude/projects/<encoded>/<uuid>.jsonl`,
// not from `tmux capture-pane` — the TUI is unparseable (ANSI/box drawing),
// the JSONL is Anthropic-native.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, readdirSync, statSync, mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Tmux helpers ─────────────────────────────────────────────────────────────

/**
 * Run a tmux subcommand. Returns { ok, stdout, stderr }. Doesn't throw on
 * non-zero exit — caller decides what to do.
 */
function tmux(args: string[], opts: { timeoutMs?: number } = {}): { ok: boolean; stdout: string; stderr: string; status: number } {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 5_000 });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    status: r.status ?? -1,
  };
}

/** True iff tmux server is reachable and the named session exists. */
export function hasSession(name: string): boolean {
  return tmux(['has-session', '-t', `=${name}`]).ok;
}

/** True iff the hermit-ui pane for `sessionId` is currently running. */
export function tmuxSessionExists(sessionId: string): boolean {
  return hasSession(paneName(sessionId));
}

/** Public version of the pane name function — callers may need it. */
export function tmuxPaneName(sessionId: string): string {
  return paneName(sessionId);
}

/** List all tmux sessions whose name starts with the given prefix. */
export function listSessions(prefix: string): string[] {
  const r = tmux(['list-sessions', '-F', '#{session_name}']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter((s) => s.startsWith(prefix));
}

// ── Session lifecycle ────────────────────────────────────────────────────────

export interface EnsureOpts {
  /** Stable id used to name the tmux session. We'll prefix with `hermit-`. */
  sessionId: string;
  /** Working directory for the spawned claude. */
  cwd: string;
  /**
   * Pre-assign claude's transcript uuid. When set, `--session-id <uuid>` is
   * appended to claudeArgs so the JSONL filename is known up-front — avoids
   * the race when two ChatSessions spin up against the same agent dir in
   * parallel (both would otherwise see "the new jsonl" and pick the same one).
   */
  claudeSessionUuid?: string;
  /** Extra args to pass to `claude` (e.g. ['--model', 'opus']). */
  claudeArgs?: string[];
  /** Path to the claude binary. Defaults to `claude` on PATH. */
  claudeBin?: string;
  /** Pane dimensions. Default 200x50 — wide enough that claude doesn't truncate tool output. */
  width?: number;
  height?: number;
}

/**
 * Idempotent: returns the tmux session name. Pre-snapshots existing JSONL files
 * in the project dir so callers can later identify which file is THIS session's
 * transcript (see getClaudeSessionUuid).
 */
export function ensureSession(opts: EnsureOpts): { name: string; created: boolean; preExistingUuids: Set<string> } {
  const name = paneName(opts.sessionId);
  const projectDir = encodedProjectDir(opts.cwd);
  mkdirSync(projectDir, { recursive: true });
  const preExistingUuids = new Set(listJsonlUuids(projectDir));

  if (hasSession(name)) {
    return { name, created: false, preExistingUuids };
  }

  const claudeBin = opts.claudeBin ?? 'claude';
  const extraArgs = [...(opts.claudeArgs ?? [])];
  if (opts.claudeSessionUuid) {
    extraArgs.push('--session-id', opts.claudeSessionUuid);
  }
  const claudeCmd = [claudeBin, ...extraArgs]
    .map((a) => shellQuote(a))
    .join(' ');

  const r = tmux([
    'new-session', '-d',
    '-s', name,
    '-c', opts.cwd,
    '-x', String(opts.width ?? 200),
    '-y', String(opts.height ?? 50),
    claudeCmd,
  ]);
  if (!r.ok) {
    throw new Error(`tmux new-session failed: ${r.stderr || 'exit ' + r.status}`);
  }
  return { name, created: true, preExistingUuids };
}

/**
 * Send a user message to the pane. Submits with Enter on the next line so
 * claude treats the buffer as a complete turn. Backslash-escapes any embedded
 * Enter via Alt+Enter so a multi-line paste doesn't accidentally submit early.
 */
export function sendKeys(sessionId: string, text: string): void {
  const name = paneName(sessionId);
  if (!hasSession(name)) throw new Error(`tmux session not found: ${name}`);

  // Strategy:
  //   For each line of `text`, paste-buffer the line, then send Alt+Enter for
  //   in-message newline. After the last line, send a single Enter to submit.
  //   Using -l (literal) avoids tmux interpreting metakeys inside user text.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 0) {
      const r = tmux(['send-keys', '-t', `${name}.0`, '-l', line]);
      if (!r.ok) throw new Error(`tmux send-keys (literal) failed: ${r.stderr || 'exit ' + r.status}`);
    }
    if (i < lines.length - 1) {
      // Mid-message line break: M-Enter ("Alt+Enter") inserts a newline in
      // claude's composer without submitting.
      const r = tmux(['send-keys', '-t', `${name}.0`, 'M-Enter']);
      if (!r.ok) throw new Error(`tmux send-keys (M-Enter) failed: ${r.stderr || 'exit ' + r.status}`);
    }
  }
  // Submit.
  const r = tmux(['send-keys', '-t', `${name}.0`, 'Enter']);
  if (!r.ok) throw new Error(`tmux send-keys (Enter) failed: ${r.stderr || 'exit ' + r.status}`);
}

/** Send Escape to interrupt the in-flight turn (claude's cancel key). */
export function sendInterrupt(sessionId: string): void {
  const name = paneName(sessionId);
  if (!hasSession(name)) return;
  tmux(['send-keys', '-t', `${name}.0`, 'Escape']);
}

/**
 * Graceful shutdown. Tries `/exit` first; falls back to kill-session after
 * `graceMs`. Resolves once the session is gone (or never existed).
 */
export async function kill(sessionId: string, graceMs = 2_000): Promise<void> {
  const name = paneName(sessionId);
  if (!hasSession(name)) return;

  tmux(['send-keys', '-t', `${name}.0`, '-l', '/exit']);
  tmux(['send-keys', '-t', `${name}.0`, 'Enter']);

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!hasSession(name)) return;
    await sleep(150);
  }
  tmux(['kill-session', '-t', name]);
}

// ── Claude session UUID lookup ───────────────────────────────────────────────

/**
 * Wait for claude to write a fresh JSONL transcript file. Returns its UUID
 * (the filename without `.jsonl`). Times out after `timeoutMs` and throws.
 *
 * Callers should pass the `preExistingUuids` set returned from ensureSession
 * so we ignore transcript files that were already there from prior sessions.
 */
export async function getClaudeSessionUuid(opts: {
  cwd: string;
  preExistingUuids: Set<string>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<string> {
  const projectDir = encodedProjectDir(opts.cwd);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(projectDir)) {
      const uuids = listJsonlUuids(projectDir);
      for (const uuid of uuids) {
        if (!opts.preExistingUuids.has(uuid)) {
          // Sanity: make sure the file is non-empty (claude has actually started
          // writing). Empty file = race with mkdir, not a real session yet.
          const stat = safeStat(join(projectDir, `${uuid}.jsonl`));
          if (stat && stat.size > 0) return uuid;
        }
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for claude transcript in ${projectDir}`);
}

/**
 * Wait for a specific JSONL path to exist and be non-empty. Use this when
 * the caller pre-assigned the uuid via `claudeSessionUuid` — no need to
 * scan for "new" files.
 */
export async function awaitTranscript(jsonlPath: string, timeoutMs = 30_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = safeStat(jsonlPath);
    if (st && st.size > 0) return;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for transcript at ${jsonlPath}`);
}

/** Returns the encoded project directory under ~/.claude/projects/. */
export function encodedProjectDir(cwd: string): string {
  // Claude Code replaces every `/` with `-`. Leading `/` becomes leading `-`.
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

/** UUID list from .jsonl files in a project dir. */
function listJsonlUuids(projectDir: string): string[] {
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length));
}

// ── Transcript watcher ───────────────────────────────────────────────────────

export interface TranscriptEvent {
  type: string;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string | null;
  message?: any;
  timestamp?: string;
  // Anything else from the JSONL line is passed through.
  [k: string]: any;
}

/**
 * Tail -F a JSONL transcript. Calls `onEvent` for each parsed line. Returns
 * a stop function. Survives file rotation (`-F` reopens). Skips lines that
 * fail to JSON.parse — claude occasionally writes partial chunks during fsync.
 *
 * Dedup is up to the caller — we just stream lines. Most events have a `.uuid`
 * field; ChatMessage upsert by `externalId = uuid` keeps the row stable.
 */
export function watchTranscript(jsonlPath: string, onEvent: (ev: TranscriptEvent) => void): () => void {
  // -n +1 = start from the first line (we want history too, in case the
  //         watcher attaches after some events have been written).
  // -F    = follow by name, re-opening on rotation.
  const child = spawn('tail', ['-n', '+1', '-F', jsonlPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // partial line during write — `tail -F` will hand us the rest next tick
      }
    }
  });

  // We let tail's stderr drop on the floor; it occasionally complains about
  // "file truncated" mid-rotation, which is expected and harmless.
  child.stderr.on('data', () => {});

  return () => {
    try { child.kill('SIGTERM'); } catch {}
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function paneName(sessionId: string): string {
  // tmux session names allow alnum + . _ -. Take 12 chars of the id (cuids are
  // 25 chars, the suffix is the entropic part) to keep the name short but
  // collision-resistant.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12);
  return `hermit-${safe}`;
}

function shellQuote(s: string): string {
  // Safe single-quote wrapping. tmux new-session's command string is run
  // through the user's $SHELL, so shell escaping is what matters.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}
