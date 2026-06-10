// Machine-level ops the dashboard queues (upgrade Claude Code, restart all
// sessions). The gateway polls MachineRequest, runs the op on THIS host, and
// writes the result back. Mirrors agent-lifecycle's request tick, but these
// touch no agent files — they run a command / drive the session restart.

import { api } from './api';
import { execCapture } from './exec';
import { paneIsWorking } from './pane';
import { restartOneSession } from './chat-runner';
import { runClaudeLogin, abortActiveLogin, type LoginReport } from './claude-login';

const RESTART_GAP_MS = 4_000; // stagger restarts — never all at once
const UPGRADE_TIMEOUT_MS = 5 * 60_000;

let busy = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runUpgrade(id: string): Promise<void> {
  // Login shell + explicit ~/.local/bin so PATH finds the native `claude`:
  // pm2/launchd-spawned processes don't inherit ~/.local/bin (see the
  // launchd_path note), and `claude` (native install) lives there.
  const res = await execCapture(
    'bash',
    ['-lc', 'export PATH="$HOME/.local/bin:$PATH"; claude --version && claude upgrade'],
    { timeoutMs: UPGRADE_TIMEOUT_MS },
  );
  const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
  const ok = res.status === 0 && !res.timedOut;
  await api.ackMachineRequest({
    id,
    status: ok ? 'done' : 'error',
    output: (out || (res.timedOut ? '(timed out)' : '(no output)')).slice(-4000),
    error: ok ? undefined : res.timedOut ? 'timeout' : `exit ${res.status}`,
  });
  console.log(`[machine-req] upgrade-claude → ${ok ? 'done' : 'error'}`);
}

async function runRestartAll(id: string): Promise<void> {
  let ids: string[];
  try {
    // pollChatPending returns this machine's live (closedAt:null) sessions.
    const pending = await api.pollChatPending();
    ids = pending.sessions.map((s) => s.id);
  } catch (e) {
    await api.ackMachineRequest({
      id,
      status: 'error',
      error: `list sessions failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  const stamp = Date.now();
  let restarted = 0;
  let skipped = 0;
  for (const sid of ids) {
    let working = false;
    try {
      working = await paneIsWorking(sid);
    } catch {
      working = false;
    }
    if (working) {
      skipped++; // don't interrupt an in-flight turn
      continue;
    }
    const did = await restartOneSession(sid, stamp);
    if (did) {
      restarted++;
      await sleep(RESTART_GAP_MS); // one at a time, staggered
    }
  }

  await api.ackMachineRequest({
    id,
    status: 'done',
    output: `restarted ${restarted} session${restarted === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} busy` : ''} · ${RESTART_GAP_MS / 1000}s apart · each resumes on its next message`,
  });
  console.log(`[machine-req] restart-all → restarted=${restarted} skipped=${skipped}`);
}

// Switch THIS machine's Claude Code account onto the one the dashboard queued.
// The sanitized account (email + 171mail token, no `sk`) is read-once via
// claimLoginPayload (the dashboard NULLs it server-side), then handed to the
// headed-Chrome orchestrator. Progress streams to `output`; a Cloudflare wall
// parks the request at `needs-human` until someone clears it at this Mac.
// The login currently being driven on this host (null when idle). The cancel
// tick below watches it; runLoginClaude owns its lifetime.
let activeLoginId: string | null = null;

async function runLoginClaude(id: string): Promise<void> {
  const creds = await api.claimLoginPayload(id).catch(() => null);
  if (!creds) {
    await api.ackMachineRequest({ id, status: 'error', error: '没拿到账号信息（可能已被领取或已过期）' }).catch(() => {});
    return;
  }
  const log: string[] = [];
  const report: LoginReport = async (u) => {
    if (u.line) log.push(u.line);
    await api.ackMachineRequest({ id, status: u.status ?? 'running', output: log.join('\n').slice(-4000) }).catch(() => {});
  };
  activeLoginId = id;
  try {
    const res = await runClaudeLogin({
      email: creds.email,
      mailToken: creds.mailToken,
      emailPassword: creds.emailPassword,
      report,
    });
    if (res.ok) {
      log.push(`✓ ${res.summary}`);
      await api.ackMachineRequest({ id, status: 'done', output: log.join('\n').slice(-4000) });
    } else {
      await api.ackMachineRequest({ id, status: 'error', output: log.join('\n').slice(-4000), error: res.error ?? res.summary });
    }
    console.log(`[machine-req] login-claude-account → ${res.ok ? 'done' : 'error'}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await api.ackMachineRequest({ id, status: 'error', output: log.join('\n').slice(-4000), error: msg }).catch(() => {});
    console.error('[machine-req] login-claude-account failed:', msg);
  } finally {
    activeLoginId = null;
  }
}

// Manual-reset path. machineRequestTick holds `busy` for the whole login, so a
// reset can't ride that loop — this runs on its own tick. If the dashboard has
// marked the in-flight login resolved (status error/done = the user hit reset),
// abort the orchestrator so Chrome closes and `busy` frees for a fresh attempt.
export async function loginCancelTick(): Promise<void> {
  const id = activeLoginId;
  if (!id) return;
  try {
    const row = await api.loginStatus();
    if (row && row.id === id && (row.status === 'error' || row.status === 'done')) {
      console.log('[machine-req] login reset detected → aborting');
      abortActiveLogin();
    }
  } catch {
    /* ignore — try again next tick */
  }
}

export async function machineRequestTick(): Promise<void> {
  if (busy) return; // ops can run for minutes (upgrade download / N×gap) — never overlap
  let reqs: Array<{ id: string; kind: string }>;
  try {
    reqs = await api.pollMachineRequests();
  } catch (e) {
    console.error('[machine-req] poll failed:', e);
    return;
  }
  if (reqs.length === 0) return;

  busy = true;
  try {
    for (const r of reqs) {
      try {
        await api.ackMachineRequest({ id: r.id, status: 'running' }).catch(() => {});
        if (r.kind === 'upgrade-claude') await runUpgrade(r.id);
        else if (r.kind === 'restart-all-sessions') await runRestartAll(r.id);
        else if (r.kind === 'login-claude-account') await runLoginClaude(r.id);
        else await api.ackMachineRequest({ id: r.id, status: 'error', error: `unknown kind: ${r.kind}` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[machine-req] ${r.kind} failed:`, msg);
        await api.ackMachineRequest({ id: r.id, status: 'error', error: msg }).catch(() => {});
      }
    }
  } finally {
    busy = false;
  }
}
