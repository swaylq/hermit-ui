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
  /**
   * Extra environment variables for the pane, passed via `tmux new-session -e
   * K=V`. claude AND every subprocess it spawns (notably PreToolUse hooks)
   * inherit these — so the permission hook gets the dashboard URL + key without
   * them ever touching the command line. Values are passed as literal argv
   * entries (no shell), so no quoting is needed.
   */
  env?: Record<string, string>;
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

  // `-e K=V` per env entry — sets the pane's session environment, inherited by
  // claude and its hook subprocesses. Literal argv (no shell), so no quoting.
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v != null && v !== '') envFlags.push('-e', `${k}=${v}`);
  }

  const r = tmux([
    'new-session', '-d',
    '-s', name,
    '-c', opts.cwd,
    '-x', String(opts.width ?? 200),
    '-y', String(opts.height ?? 50),
    ...envFlags,
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
      // `--` terminates option parsing so a line starting with `-` (markdown
      // bullets, LaTeX, diffs) is sent as literal text, not mistaken for a flag.
      const r = tmux(['send-keys', '-t', `${name}.0`, '-l', '--', line]);
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

// Read the composer's input line (`❯ …`). Tri-state so a FAILED capture is never
// mistaken for "empty": 'text' = still holds buffered (unsent) text, 'clear' =
// positively empty (submitted), 'unknown' = capture failed OR no composer line was
// visible this frame (a transient render). confirmSubmitted only concludes
// "submitted" on 'clear' — returning false here on a capture timeout used to
// silently strand a multi-line / image paste whose submit Enter got swallowed.
function composerStatus(name: string): 'text' | 'clear' | 'unknown' {
  const r = tmux(['capture-pane', '-t', `${name}.0`, '-p'], { timeoutMs: 2000 });
  if (!r.ok) return 'unknown';
  const lines = r.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf('❯');
    if (idx >= 0) return lines[i].slice(idx + 1).trim().length > 0 ? 'text' : 'clear';
  }
  return 'unknown';
}

/**
 * Make sure a sent message actually submitted. claude's Ink TUI drops the submit
 * Enter while it's still settling — most often right after a LONG turn, when the
 * pane reads "idle" (no "esc to interrupt" marker, so the deliver gate lets us
 * send) but claude is still rendering that turn's large output, so Enters are
 * swallowed. A multi-line paste (user text + a `Read <image>` line) makes it
 * likelier still. The text lands in the composer but never sends.
 *
 * We re-send Enter while the composer still shows buffered text, polling until it
 * clears. Idempotent: an Enter on an already-empty composer is a no-op, so extra
 * rounds never double-submit. The window must outlast a big-output render settle
 * (the old 0.8s gave up mid-render → the message sat unsent forever, since the
 * caller has already ack'd it and won't redeliver). Returns true once the composer
 * clears (submitted), false if it still holds text at the end — the caller surfaces
 * that so a stuck message is never silent. (Past incident 2026-06-03: a follow-up
 * sent right after an 8m turn sat in the composer, unsent.)
 */
export async function confirmSubmitted(sessionId: string, tries = 40, gapMs = 500): Promise<boolean> {
  const name = paneName(sessionId);
  if (!hasSession(name)) return true;
  for (let i = 0; i < tries; i++) {
    await sleep(gapMs);
    if (composerStatus(name) === 'clear') return true; // POSITIVELY empty → submitted
    // 'text' (still buffered) or 'unknown' (capture failed / composer not seen this
    // frame) → re-send Enter and keep polling. We must NOT treat a failed capture as
    // "cleared": that's exactly what stranded image / multi-line pastes — the
    // settle-render capture timed out, we reported success, and the message sat
    // unsent with no warning (the user had to press Enter in the pane themselves).
    tmux(['send-keys', '-t', `${name}.0`, 'Enter']);
  }
  return composerStatus(name) === 'clear';
}

/** Public read of a pane's composer state (tri-state; see composerStatus). */
export function readComposer(sessionId: string): 'text' | 'clear' | 'unknown' {
  return composerStatus(paneName(sessionId));
}

/**
 * Wait until the pane's REPL has rendered its composer prompt (the `❯` line is
 * visible) — i.e. claude is up and able to accept typed input. Typing BEFORE this
 * is the cold-start race that silently drops a session's first message: the keys
 * (and the submit Enter) land in a not-yet-ready Ink TUI and vanish, the composer
 * stays empty, and an empty composer otherwise reads as "submitted". Returns true
 * once the composer is readable, false on timeout / dead pane.
 */
export async function waitForReplReady(sessionId: string, timeoutMs = 45_000, gapMs = 500): Promise<boolean> {
  const name = paneName(sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!hasSession(name)) return false;
    if (composerStatus(name) !== 'unknown') return true; // ❯ visible → REPL ready
    await sleep(gapMs);
  }
  return composerStatus(name) !== 'unknown';
}

/**
 * `claude --resume` on a LARGE session blocks on an in-pane prompt before the
 * REPL loads:
 *     This session is Xh old and Nk tokens. … We recommend resuming from a summary.
 *      ❯ 1. Resume from summary (recommended)
 *        2. Resume full session as-is
 *        3. Don't ask me again
 * It's painted in the tmux pane and never reaches the web chat, so the session
 * hangs forever (the caller's getClaudeSessionUuid waits on a transcript that
 * never appears). Watch the pane and auto-pick option 2 — "Resume full session
 * as-is" — to keep the COMPLETE history. `Up Up` returns ❯ to the top from
 * wherever it sits, `Down` moves to option 2, `Enter` confirms; the sequence is
 * idempotent, so re-issuing it each tick the prompt is still up (tmux drops keys
 * — the same hazard confirmSubmitted handles) never lands on the wrong option.
 * No-op if the prompt never appears (small sessions resume straight to the REPL).
 * Fire-and-forget: runs in the background alongside the resume.
 */
export async function acceptResumePromptAsFull(sessionId: string, tries = 40, gapMs = 500): Promise<boolean> {
  const name = paneName(sessionId);
  let answered = false;
  for (let i = 0; i < tries; i++) {
    await sleep(gapMs);
    if (!hasSession(name)) return answered; // pane gone — nothing to answer
    const cap = tmux(['capture-pane', '-t', `${name}.0`, '-p'], { timeoutMs: 2_000 });
    if (!cap.ok) continue;
    const pane = cap.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    if (!(pane.includes('Resume full session as-is') && pane.includes('Resume from summary'))) {
      if (answered) return true; // we answered and the prompt has cleared
      continue; // not up yet — keep watching
    }
    // Prompt is up. Read which option the ❯ cursor sits on and take ONE step
    // toward option 2 ("Resume full session as-is"), re-reading each tick — robust
    // to tmux dropping a key and to whatever the menu's wrap behavior is (never
    // assumes a fixed start). Confirm with Enter only once the cursor is on 2.
    const cursorLine = pane.split('\n').find((l) => l.includes('❯')) ?? '';
    if (cursorLine.includes('Resume full session as-is')) {
      tmux(['send-keys', '-t', `${name}.0`, 'Enter']); // on option 2 → confirm
      answered = true;
    } else if (cursorLine.includes('Resume from summary')) {
      tmux(['send-keys', '-t', `${name}.0`, 'Down']); // on option 1 → step down to 2
    } else if (cursorLine.includes("Don't ask me again")) {
      tmux(['send-keys', '-t', `${name}.0`, 'Up']); // on option 3 → step up to 2
    }
    // cursor not located yet → wait and re-read next tick
  }
  return answered;
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

  tmux(['send-keys', '-t', `${name}.0`, '-l', '--', '/exit']);
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

/**
 * Every JSONL transcript in an agent's project dir, with size + mtime. Used to
 * detect + recover claude-session-uuid DRIFT: when a pane's claude was respawned
 * without `--session-id` and minted a uuid the gateway never recorded, the gateway
 * tails a `<recorded-uuid>.jsonl` that never appears. The caller finds the live
 * transcript here (newest non-empty, excluding uuids owned by sibling sessions that
 * share this project dir) and adopts it.
 */
export function listTranscripts(cwd: string): Array<{ uuid: string; size: number; mtimeMs: number }> {
  const projectDir = encodedProjectDir(cwd);
  const out: Array<{ uuid: string; size: number; mtimeMs: number }> = [];
  for (const uuid of listJsonlUuids(projectDir)) {
    const st = safeStat(join(projectDir, `${uuid}.jsonl`));
    if (st) out.push({ uuid, size: Number(st.size), mtimeMs: Number(st.mtimeMs) });
  }
  return out;
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
