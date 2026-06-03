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

// Scan only the last few rows (the mode line sits at the bottom) so a chat
// message that happens to contain the words can't trigger a false "working".
const WORK_MARKER_RE = /\besc(?:ape)?\s+to\s+(?:interrupt|cancel|stop)\b/i;

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
      resolve(WORK_MARKER_RE.test(lines.slice(-6).join('\n')));
    });
  });
}
