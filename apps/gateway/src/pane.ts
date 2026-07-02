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

function transcriptFresh(transcriptPath: string | null | undefined): boolean {
  if (!transcriptPath) return false;
  try {
    return Date.now() - fs.statSync(transcriptPath).mtimeMs < TRANSCRIPT_FRESH_MS;
  } catch {
    return false; // missing / unreadable → no signal, fall through to the pane
  }
}

// `transcriptPath` (optional) enables the width-independent freshness check; pass
// it wherever you have the session's claude transcript (snapshot, delivery gate).
// Omitted → pure pane-marker behaviour (reaper / cron / machine-requests).
export function paneIsWorking(sessionId: string, transcriptPath?: string | null): Promise<boolean> {
  // Cheap, width-independent check first: an actively-writing transcript means a
  // turn is in flight — and short-circuits the tmux shell-out during active turns.
  // Falls through to the pane marker for the quiet phases (a long silent think
  // writes nothing but shows the spinner-timer, which survives narrow truncation).
  if (transcriptFresh(transcriptPath)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('tmux', ['capture-pane', '-t', tmuxPaneName(sessionId), '-p'], { timeout: 2_000 });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => {
      const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.trim());
      // Scan more rows than the bottom mode line alone — tool results, a periodic
      // "How is Claude doing?" feedback nag, and the composer can push the spinner
      // status line several rows up from the very bottom.
      resolve(WORK_MARKER_RE.test(lines.slice(-12).join('\n')));
    });
  });
}
