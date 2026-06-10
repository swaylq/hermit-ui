// pane.ts — the single source of truth for "is this session's claude actively
// working?". Claude Code's TUI shows "esc to interrupt" in its bottom mode line
// ONLY while a turn is in flight (thinking, running a tool, streaming) and drops
// it the instant it goes idle. capture-pane + scanning the last few rows for that
// marker is the ground truth — it matches exactly what the user sees and, unlike
// a "last JSONL line < Ns ago" heuristic, doesn't go stale during a long silent
// think. Used by the session-snapshot collector, the chat dispatch gate, and the
// cron-runner. spawn is async so it never blocks the event loop.
import { spawn } from 'node:child_process';
import { tmuxPaneName } from '@hermit-ui/tmux-driver';

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

export function paneIsWorking(sessionId: string): Promise<boolean> {
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
