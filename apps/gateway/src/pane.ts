// pane.ts — the single source of truth for "is this session's claude actively
// working?". Claude Code's TUI shows "esc to interrupt" in its bottom mode line
// ONLY while a turn is in flight (thinking, running a tool, streaming) and drops
// it the instant it goes idle. capture-pane + scanning the last few rows for that
// marker is the ground truth — it matches exactly what the user sees and, unlike
// a "last JSONL line < Ns ago" heuristic, doesn't go stale during a long silent
// think. Used by the session-snapshot collector, the chat dispatch gate, and the
// cron-runner. spawn is async so it never blocks the event loop.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmuxPaneName, encodedProjectDir } from '@hermit-ui/tmux-driver';
import { isNonTurnEvent, CcEvent, hasToolUse, hasToolResult } from './claude-code';

// Claude Code's in-flight turn renders a spinner status line like
//   "✶ Considering… (6m 44s · thinking)"  /  "✽ Warping… (10m 46s · ↓ 43.1k tokens)"
// and, on the bottom mode line, "· esc to interrupt". The instant the turn ends the
// spinner is REPLACED by a past-tense done-line "✻ Cooked for 4m 57s" (no parens)
// and the mode line flips to "· ← for agents" / "? for shortcuts". Empirically
// verified on Claude Code v2.1.160 (2026-06-10): while working BOTH signals are
// present; while idle BOTH are gone.
//
// We match EITHER (robust across versions — an earlier 2.x build dropped the literal
// "esc to interrupt" from the mode line, leaving only the spinner timer):
//   1. the live elapsed timer "… (<Ns> ·" / "… (<Nm Ns> ·". The leading "…" (the
//      spinner verb's ellipsis) is REQUIRED so a stray parenthesised duration in
//      assistant prose / tool output (e.g. "done in (3s · 200ms)") sitting on an
//      IDLE pane no longer reads as work — the past-tense done-line has no "(", and
//      prose practically never prints "… (Ns ·". (This was the bug: the old bare
//      "\((Ns ·" matched leftover output and queued messages to idle agents +
//      pinned their status to "working".)
//   2. the bottom-mode-line hint "esc to interrupt". We deliberately DROP the old
//      "cancel|stop" alternates — those are modal-dismiss hints (handled separately
//      by streamSlashOutput's ESC_HINT_RE), not in-flight work, so an idle pane
//      showing a dismissable modal no longer reads as working.
export const WORK_MARKER_RE = /(?:…|\.\.\.)\s*\((?:\d+m\s*)?\d+s\s*[·•∙]|\besc(?:ape)?\s+to\s+interrupt\b/i;

// ── Width-independent second signal: transcript freshness ────────────────────
// The pane marker above is the ground truth, but it FAILS on NARROW panes: at
// ≤~60 cols Claude Code truncates the bottom mode line to "· …", cutting off
// "esc to interrupt" — so a working pane looks identical to an idle one, and if
// the turn is mid-tool-call (no model spinner-timer on screen) there's nothing
// left to match → a live turn reads idle. A live turn is still APPENDING to its
// JSONL transcript (tool_use / tool_result / assistant blocks), so a freshly
// written transcript is a width-independent "in flight" signal. We OR the two:
//   - tool executing on a narrow pane → transcript fresh → working (was the bug)
//   - long SILENT think → transcript quiet, BUT the spinner-timer is on the pane
//     (it survives narrow truncation) → the marker catches it. This is exactly
//     why we DON'T use transcript freshness ALONE — it goes stale mid-think, the
//     original reason pane-scraping was chosen.
// The window sits just above the 8s snapshot cadence so a write in the last tick
// still reads busy. Cost: a session reads "working" for up to ~10s after its turn
// actually ends (the final write's mtime lingers) — a deliberate bias toward
// "busy", the SAFE direction for every caller (never deliver into / reap / flip a
// still-running turn to ready).
const TRANSCRIPT_FRESH_MS = 10_000;

// The Claude Code JSONL transcript path for a session, or null when unknown (no
// claude session id yet / no agent dir). Same layout the session-snapshot uses.
export function sessionTranscriptPath(
  claudeSessionId: string | null | undefined,
  agentDir: string | null | undefined,
): string | null {
  if (!claudeSessionId || !agentDir) return null;
  return path.join(encodedProjectDir(agentDir), `${claudeSessionId}.jsonl`);
}

// Claude Code appends non-turn METADATA to an otherwise-idle transcript — most
// notably a `bridge-session` event each time a new bridge connects to a
// --resume'd session (a dashboard SSE / browser-terminal (re)connect). Those bump
// the file mtime with NO turn in flight, so a pure mtime<window freshness check
// flips a long-finished session to "working" for ~10s every time one lands — the
// "occasionally shows working then settles" flap — and, worse, briefly gates
// delivery (a send in that window queues instead of landing). So the freshness
// signal only counts when the NEWEST line is a real turn (assistant / user
// content); a metadata write falls through to the authoritative pane-marker read.
// NON_TURN_EVENT_TYPES + isNonTurnEvent now live in ./claude-code (shared vocabulary).

// Whether the newest complete JSONL line is a real turn event. bridge-session /
// summary lines are tiny (fully captured in the tail); a huge last line is a real
// assistant/tool block mid-write, so an unparseable partial — or ANY read failure —
// conservatively counts AS a turn: we only ever suppress the KNOWN metadata types,
// never real work.
export function newestLineIsTurn(transcriptPath: string): boolean {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const readLen = Math.min(size, 8192);
      if (readLen === 0) return true;
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, size - readLen);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (!last) return true;
      let ev: { type?: string };
      try { ev = JSON.parse(last); } catch { return true; } // partial huge line = real turn block
      return !isNonTurnEvent(ev?.type);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true; // read failed → don't suppress the freshness signal
  }
}

export function transcriptFresh(transcriptPath: string | null | undefined): boolean {
  if (!transcriptPath) return false;
  try {
    if (Date.now() - fs.statSync(transcriptPath).mtimeMs >= TRANSCRIPT_FRESH_MS) return false;
  } catch {
    return false; // missing / unreadable → no signal, fall through to the pane
  }
  // mtime is fresh — but a bridge-session / metadata write bumps mtime without a
  // turn in flight, so confirm the newest line is an actual turn before calling it
  // working. If it isn't, we fall through to the pane marker (the real idle/busy read).
  return newestLineIsTurn(transcriptPath);
}

// ── Retroactive width-independent signal: an in-flight tool call ──────────────
// A single tool call writes an assistant `tool_use` event when the tool STARTS and a
// user `tool_result` event when it returns. So a turn is mid-tool-call iff the newest
// tool_use is newer than the newest tool_result. This is a width-independent, hook-free,
// RETROACTIVE working signal: it catches a long quiet tool call on a narrow pane (where
// the "esc to interrupt" / spinner marker has truncated off AND the transcript mtime has
// gone stale) even for a session whose turn-state hook isn't wired / hasn't reloaded —
// no session restart required. Capped so an abandoned tool_use (claude killed mid-tool,
// so tool_result never lands) self-heals instead of pinning "working" forever. The
// pane-alive short-circuit in the snapshot collector already handles the common crash
// case (dead pane → not working). Takes the caller's pre-read transcript tail (the
// snapshot already reads it for usage/text) so it adds no file I/O of its own.
const TOOL_RUNNING_CAP_MS = 20 * 60_000;
export function transcriptToolRunning(lines: string[]): boolean {
  let tuMax = 0, trMax = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tuMax && trMax) break; // both newest-of-kind found (scanning newest-first)
    let ev: any;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    const t = Date.parse(ev.timestamp || '') || 0;
    if (!tuMax && ev.type === CcEvent.assistant && hasToolUse(content)) tuMax = t;
    if (!trMax && ev.type === CcEvent.user && hasToolResult(content)) trMax = t;
  }
  return tuMax > 0 && tuMax > trMax && Date.now() - tuMax < TOOL_RUNNING_CAP_MS;
}

// ── Authoritative width-independent signal: the turn-state hook ──────────────
// hook-session-state.sh (wired as UserPromptSubmit / PreToolUse / Stop hooks) keeps
// <agentDir>/.claude/state/session-status.json: state "running" from prompt-submit
// until Stop fires, with unix-second heartbeats. This is the ONLY signal that stays
// true through a long, SILENT tool call on a narrow pane — where the mode-line marker
// has truncated off AND the transcript has gone quiet (the residual gap the freshness
// check alone couldn't close). Two guards keep it honest:
//   • session_id — the file is agent-level (shared by every chat session of the
//     agent), so it only speaks for the session that owns the current turn.
//   • a staleness cap — a turn that died abnormally never fires Stop, so "running"
//     would pin forever. Once the newest heartbeat is older than the cap we stop
//     trusting it (self-heal). The cap only needs to exceed a single tool call's
//     runtime; a normal multi-tool turn refreshes last_tool_ts on every PreToolUse.
const HOOK_RUNNING_CAP_MS = 15 * 60_000;
// Panes at least this wide render "esc to interrupt" WITHOUT truncating, so their
// read is authoritative — the hook fallback is neither needed nor wanted there (it
// must not override a genuinely-idle wide pane, e.g. right after an abnormal exit).
// Below it the mode line collapses to "· …" and the hook state is the only way to
// tell a live turn from an idle one. (52-col phone panes truncate; 152/200 don't.)
const WIDE_PANE_COLS = 90;

// Path to the turn-state file the hook writes, or null when the agent dir is unknown.
export function sessionStatusPath(agentDir: string | null | undefined): string | null {
  if (!agentDir) return null;
  return path.join(agentDir, '.claude', 'state', 'session-status.json');
}

// Is the hook reporting THIS session mid-turn (and recently enough to trust)?
function hookTurnActive(
  agentDir: string | null | undefined,
  claudeSessionId: string | null | undefined,
): boolean {
  const p = sessionStatusPath(agentDir);
  if (!p || !claudeSessionId) return false;
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s?.session_id !== claudeSessionId || s?.state !== 'running') return false;
    // Stamps are unix SECONDS (`date +%s` in the hook).
    const lastMs = Math.max(Number(s.last_user_prompt_ts) || 0, Number(s.last_tool_ts) || 0) * 1000;
    return Date.now() - lastMs < HOOK_RUNNING_CAP_MS;
  } catch {
    return false; // missing / unparseable → no signal, fall through to the pane
  }
}

// ── The single verdict: capture the pane once, then compose every signal ──────
// Capture the pane ONE time and report both whether the work-marker is visible and
// the pane width (widest rendered row ≈ pane cols — the composer's full-width rules
// are always drawn). null when the capture can't run (no pane / spawn failure); the
// caller treats that as "not working" (a missing pane is idle). Scan the last 12 rows
// (not just the bottom mode line) — tool results, a periodic "How is Claude doing?"
// feedback nag, and the composer can push the spinner status line up from the bottom.
function capturePaneMarker(sessionId: string): Promise<{ marker: boolean; cols: number } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('tmux', ['capture-pane', '-t', tmuxPaneName(sessionId), '-p'], { timeout: 2_000 });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.trim());
      const marker = WORK_MARKER_RE.test(lines.slice(-12).join('\n'));
      const cols = lines.reduce((m, l) => (l.length > m ? l.length : m), 0);
      resolve({ marker, cols });
    });
  });
}

// Which signal decided the verdict — observability, so a caller can log WHY a session
// read working/idle instead of re-deriving it. (Not persisted; the wire schema is
// unchanged.) Ordered cheapest-first, matching sessionActivity's short-circuit order.
export type ActivityReason =
  | 'transcript-fresh' // newest turn line written within TRANSCRIPT_FRESH_MS
  | 'tool-running'     // a tool_use with no matching tool_result yet (retroactive)
  | 'pane-marker'      // "esc to interrupt" / spinner timer visible on the pane
  | 'hook-active'      // turn-state hook says running (narrow pane, marker truncated off)
  | 'idle';            // none of the above
export interface SessionActivity {
  working: boolean;
  reason: ActivityReason;
}

// THE single "is this session's claude working?" verdict — every caller (snapshot
// collector, send / delivery gates, cron settle-loop) routes through this so they can
// never reach different answers about the same session. ORs the four signals in
// cheapest-first order and names the winner:
//   1. transcript freshness — width-independent, no shell-out (short-circuits active turns)
//   2. in-flight tool call  — retroactive, only when the caller supplies the transcript
//                             tail (`transcriptLines`): a long quiet tool call on a narrow,
//                             not-yet-hook-wired pane that both the marker AND freshness miss
//   3. pane work-marker     — the authoritative "esc to interrupt" / spinner read
//   4. turn-state hook      — narrow-pane-only fallback (marker truncated off the mode line)
// Callers with no session context (reaper / cron / machine-requests) pass only the
// sessionId → pure pane-marker behaviour, exactly as before. Every ORed condition
// biases toward "busy", the SAFE direction for every caller (never deliver into / reap
// / flip a still-running turn to ready).
export async function sessionActivity(
  sessionId: string,
  opts: {
    transcriptPath?: string | null;
    agentDir?: string | null;
    claudeSessionId?: string | null;
    transcriptLines?: string[];
  } = {},
): Promise<SessionActivity> {
  const { transcriptPath, agentDir, claudeSessionId, transcriptLines } = opts;
  if (transcriptFresh(transcriptPath)) return { working: true, reason: 'transcript-fresh' };
  if (transcriptLines?.length && transcriptToolRunning(transcriptLines)) {
    return { working: true, reason: 'tool-running' };
  }
  const pane = await capturePaneMarker(sessionId);
  if (pane?.marker) return { working: true, reason: 'pane-marker' };
  if (pane && pane.cols < WIDE_PANE_COLS && hookTurnActive(agentDir, claudeSessionId)) {
    return { working: true, reason: 'hook-active' };
  }
  return { working: false, reason: 'idle' };
}

// Backward-compatible boolean alias — the send / queue-drain / cron gates only need
// the yes/no. ZERO independent logic: one verdict (sessionActivity), one source of
// truth. `transcriptPath` enables the freshness check; `agentDir` + `claudeSessionId`
// enable the narrow-pane hook fallback. No `transcriptLines`, so the tool-running
// signal is inert here — identical behaviour to before the unification.
export function paneIsWorking(
  sessionId: string,
  transcriptPath?: string | null,
  agentDir?: string | null,
  claudeSessionId?: string | null,
): Promise<boolean> {
  return sessionActivity(sessionId, { transcriptPath, agentDir, claudeSessionId }).then((v) => v.working);
}
