// collect/plan-usage.ts — scrape the REAL Claude Max plan consumption that
// `claude /usage` shows (5-hour "session" % + weekly %), by driving the actual
// /usage TUI in a throwaway tmux pane and reading the rendered panel.
//
// This is the ONLY way to get these numbers: the underlying
// `anthropic-ratelimit-unified-*` headers are request-to-request HTTP metadata
// and aren't persisted anywhere (confirmed via claude-code-guide). `ccusage`
// (collect/usage.ts + window.ts) is a different, cost-ESTIMATE metric (token
// counts × API list price) and never matches /usage — which is why the old
// dashboard numbers looked wrong for a Max subscriber.
//
// Cost per poll: one minimal /usage API call + a ~20s throwaway claude session.
// Runs infrequently (see index.ts). The probe dir is trusted on first run (we
// accept the prompt either way), so later polls skip it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROBE_DIR = path.join(os.homedir(), '.hermit', 'usage-probe');
const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude');
const SESSION = 'hermit-usage-probe';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tmux(args: string[]): string {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: 10_000 });
  return r.stdout ?? '';
}
function capture(): string {
  // -S -90: the panel is taller than the pane, so the 5h section lives in scrollback.
  return tmux(['capture-pane', '-t', SESSION, '-p', '-S', '-90']);
}
function killPane(): void {
  spawnSync('tmux', ['kill-session', '-t', SESSION], { timeout: 5_000 });
}

export type PlanUsage = {
  sessionPct: number | null;     // 5-hour rolling window
  weekPct: number | null;        // weekly (all models)
  weekSonnetPct: number | null;  // weekly Sonnet sub-limit
  sessionResetText: string | null;
  weekResetText: string | null;
  capturedAt: string;
};

function pctAfter(text: string, label: string): number | null {
  const i = text.indexOf(label);
  if (i < 0) return null;
  const m = text.slice(i + label.length, i + label.length + 200).match(/(\d+)%\s*used/);
  return m ? parseInt(m[1], 10) : null;
}
function resetAfter(text: string, label: string): string | null {
  const i = text.indexOf(label);
  if (i < 0) return null;
  const m = text.slice(i + label.length, i + label.length + 300).match(/Resets ([^\n│]+)/);
  return m ? m[1].trim() : null;
}

function parsePanel(text: string): PlanUsage | null {
  const sessionPct = pctAfter(text, 'Current session');
  const weekPct = pctAfter(text, 'Current week (all models)');
  const weekSonnetPct = pctAfter(text, 'Current week (Sonnet only)');
  if (sessionPct == null && weekPct == null) return null; // panel not rendered yet
  return {
    sessionPct,
    weekPct,
    weekSonnetPct,
    sessionResetText: resetAfter(text, 'Current session'),
    weekResetText: resetAfter(text, 'Current week (all models)'),
    capturedAt: new Date().toISOString(),
  };
}

export async function collectPlanUsage(): Promise<PlanUsage | null> {
  if (!fs.existsSync(CLAUDE_BIN)) return null;
  try { fs.mkdirSync(PROBE_DIR, { recursive: true }); } catch { /* ignore */ }
  killPane(); // clear any stale probe

  tmux(['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50']);
  tmux(['send-keys', '-t', SESSION, `cd ${PROBE_DIR} && ${CLAUDE_BIN} --dangerously-skip-permissions`, 'Enter']);

  // Wait for claude to be input-ready, accepting the first-run trust prompt.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const t = capture();
    if (/trust this folder/i.test(t)) { tmux(['send-keys', '-t', SESSION, 'Enter']); continue; }
    if (/for agents|bypass permissions on|\? for shortcuts|\/effort/i.test(t)) { ready = true; break; }
  }
  if (!ready) { killPane(); return null; }

  // Open the usage panel (slash command → autocomplete → Enter executes).
  tmux(['send-keys', '-t', SESSION, '/usage']);
  await sleep(500);
  tmux(['send-keys', '-t', SESSION, 'Enter']);

  // Poll until the panel renders (it makes one API call to refresh the headers).
  let result: PlanUsage | null = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const parsed = parsePanel(capture());
    if (parsed) { result = parsed; break; }
  }
  killPane();
  return result;
}
