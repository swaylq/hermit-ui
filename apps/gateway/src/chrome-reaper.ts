// chrome-reaper.ts — stop idle per-agent Chrome instances (resource governance).
//
// Each agent self-manages its own Chrome (scripts/chrome-launcher.sh: isolated
// browser/user-data + a 19900-19999 CDP port). A Chrome instance is ~1GB
// resident and is launched detached (nohup … & disown → ppid 1), so NOTHING
// reaped it: not the session idle-reaper (which only kills the ~500MB claude
// pane, leaving Chrome orphaned), not a session Stop. They piled up until the
// 16GB host OOM'd and jetsam killed the whole stack (2026-06-30 macmini1).
//
// browser-lock.sh now stops the Chrome it starts (ephemeral mode), so this is
// the SAFETY NET for the cases that bypass it: a crashed script, a Chrome
// started manually, or one orphaned by an OOM/SSH restart. We stop any agent
// Chrome that is (a) not currently driving a browser-lock task and (b) has been
// up past the idle grace. DB-leader: we read the agent list from the dashboard
// (api.listAgentDirectories), never scanning a filesystem root.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { api } from './api';

// Reap a Chrome with no live browser-lock that has existed longer than this. The
// grace also covers the launch→first-lock window so we never kill a Chrome that
// was started microseconds ago and hasn't acquired its lock yet.
const IDLE_MS = Number(process.env.HERMIT_CHROME_IDLE_MS ?? 10 * 60_000);
const STOP_GRACE_MS = 2_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A browser-lock task is running for this agent iff the lock file names a live
// PID. Matches browser-lock.sh: /tmp/hermit-browser-<agentName>.lock, first
// whitespace-delimited token = the holder PID.
function lockHeld(agentName: string): boolean {
  try {
    const first = fs.readFileSync(`/tmp/hermit-browser-${agentName}.lock`, 'utf8').trim().split(/\s+/)[0];
    const pid = Number(first);
    return Number.isFinite(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// SIGTERM (Chrome exits cleanly), escalate to SIGKILL if it lingers, and clear
// the PID from chrome.json so neither we nor the launcher think it's still up.
function stopChrome(pid: number, chromeJson: string): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }, STOP_GRACE_MS);
  try {
    const j = readJson(chromeJson) ?? {};
    j.pid = null;
    fs.writeFileSync(chromeJson, JSON.stringify(j, null, 2));
  } catch {
    /* best effort */
  }
}

export async function chromeReaperTick(): Promise<void> {
  let entries: Array<{ name: string; directory: string | null }>;
  try {
    entries = await api.listAgentDirectories();
  } catch {
    return; // dashboard blip — retry next tick
  }

  const now = Date.now();
  let reaped = 0;
  for (const e of entries) {
    if (!e.directory) continue;
    const chromeJson = path.join(e.directory, 'browser', 'chrome.json');
    let st: fs.Stats;
    try {
      st = fs.statSync(chromeJson);
    } catch {
      continue; // no Chrome ever launched for this agent
    }
    const pid = Number((readJson(chromeJson) ?? {}).pid);
    if (!Number.isFinite(pid) || pid <= 0 || !pidAlive(pid)) continue; // not running
    const agentName = path.basename(e.directory); // == browser-lock.sh's AGENT_NAME
    if (lockHeld(agentName)) continue; // a browser task is using it right now
    if (now - st.mtimeMs < IDLE_MS) continue; // too fresh to be considered idle
    stopChrome(pid, chromeJson);
    reaped++;
    console.log(`[chrome-reaper] stopped idle Chrome for ${agentName} (pid ${pid})`);
  }
  if (reaped > 0) console.log(`[chrome-reaper] reaped ${reaped} idle Chrome instance(s)`);
}
