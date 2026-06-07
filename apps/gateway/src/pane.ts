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

// Claude Code's in-flight turn shows a spinner status line like
//   "✶ Considering… (6m 44s · thinking)"  /  "✻ Cooking… (12s · esc to interrupt)"
// The verb + spinner glyph rotate, and as of Claude Code 2.x the literal
// "esc to interrupt" is GONE — the hint after the live elapsed timer is now
// "· thinking" etc. The stable, low-false-positive signal is that elapsed-time
// token "(<Ns> ·" / "(<Nm Ns> ·", which renders ONLY while a turn is running;
// the legacy "esc to interrupt" stays as a fallback. (Keying solely on the
// latter made every 2.x session read as idle — wedging the status + the queue.)
export const WORK_MARKER_RE = /\((?:\d+m\s*)?\d+s\s*[·•∙]|\besc(?:ape)?\s+to\s+(?:interrupt|cancel|stop)\b/i;

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
