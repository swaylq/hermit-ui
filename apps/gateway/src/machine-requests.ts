// Machine-level ops the dashboard queues (upgrade Claude Code, restart all
// sessions, update/restart the gateway itself). The gateway polls
// MachineRequest, runs the op on THIS host, and writes the result back. Mirrors
// agent-lifecycle's request tick, but these touch no agent files — they run a
// command / drive the session restart.

import { spawn } from 'node:child_process';
import { api } from './api';
import { execCapture } from './exec';
import { sessionIsBusy } from './session-busy';
import { restartOneSession } from './chat-runner';

const RESTART_GAP_MS = 4_000; // stagger restarts — never all at once
const UPGRADE_TIMEOUT_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 3 * 60_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
// Long enough for the ack HTTP call to land before pm2 kills this process.
const RESTART_DELAY_SEC = 3;

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
  // The whole row, not just the id: which backend runs a session is what decides
  // who can answer "is it mid-turn?", and the answer used to be asked of a pane
  // that claude-sdk sessions do not have (see ./session-busy).
  let sessions: Awaited<ReturnType<typeof api.pollChatPending>>['sessions'];
  try {
    // pollChatPending returns this machine's live (closedAt:null) sessions.
    const pending = await api.pollChatPending();
    sessions = pending.sessions;
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
  for (const s of sessions) {
    if (await sessionIsBusy(s)) {
      skipped++; // don't interrupt an in-flight turn
      continue;
    }
    const did = await restartOneSession(s.id, stamp);
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

// ── Gateway self-service ──────────────────────────────────────────────────────
// Both ops below end by killing the process that is running them, so the order
// is always: finish the work → ack → hand the restart to something that
// outlives us.

/** Single-quote for `bash -lc`. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run one line through a login shell, stdout+stderr joined.
 *
 * A login shell because that is what finds pm2, git and npm on every machine's
 * PATH; pm2 spawns this gateway with a PATH of its own that has none of the
 * per-user shims. The git vars make a fetch FAIL rather than hang: under pm2
 * there is no terminal to type a password into and often no ssh-agent, and the
 * default there is a prompt that waits until the timeout.
 */
async function sh(line: string, timeoutMs: number) {
  const res = await execCapture('bash', ['-lc', line], {
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
  });
  return {
    ok: res.status === 0 && !res.timedOut,
    out: [res.stdout, res.stderr].filter(Boolean).join('\n').trim(),
    timedOut: res.timedOut,
  };
}

export type Pm2Self = { app: string; repo: string };

/**
 * Which pm2 entry is THIS process, and which checkout does it run from.
 *
 * Matched by pid rather than by name: the app is `hermit-ui-gateway` on every
 * machine today, but a name is a guess and a pid is a fact — and a second
 * gateway (a test app, a staging checkout) would otherwise be restarted in our
 * place. The repo comes off pm2's own cwd minus `/apps/gateway`, the same
 * derivation scripts/gateway-watch.sh uses, so a gateway run from anywhere
 * still updates the checkout it actually runs.
 *
 * Exported for the test. It is asked through a LOGIN shell (that is what finds
 * pm2 on every machine's PATH), so the output can carry a profile banner ahead
 * of the JSON — and a banner is free to contain a `[` of its own, which is why
 * this walks the candidates instead of trusting the first one.
 */
export function pickPm2Self(stdout: string, pid: number): Pm2Self | null {
  for (let i = stdout.indexOf('['); i >= 0; i = stdout.indexOf('[', i + 1)) {
    let list: unknown;
    try {
      list = JSON.parse(stdout.slice(i));
    } catch {
      continue; // banner noise that happened to contain a bracket
    }
    if (!Array.isArray(list)) continue;
    const me = (list as Array<{ name?: string; pid?: number; pm2_env?: { pm_cwd?: string } }>)
      .find((p) => p?.pid === pid);
    if (!me?.name) return null; // pm2 answered, and none of its apps is us
    const cwd = me.pm2_env?.pm_cwd ?? '';
    const suffix = '/apps/gateway';
    return { app: me.name, repo: cwd.endsWith(suffix) ? cwd.slice(0, -suffix.length) : cwd };
  }
  return null;
}

async function pm2Self(): Promise<Pm2Self | null> {
  const res = await sh('pm2 jlist', 30_000);
  return res.out ? pickPm2Self(res.out, process.pid) : null;
}

/**
 * Restart this gateway, from outside this gateway.
 *
 * `pm2 restart` is ONE RPC into the pm2 daemon, so the daemon completes
 * stop+start even though it kills the CLI child that asked (and this process
 * with it). `pm2 delete` would not — it treekills the caller and the follow-up
 * start never runs, which is the 5h33m blackout of 2026-08-23. Never delete,
 * never stop.
 *
 * Detached so the child starts its own session, and delayed a few seconds so
 * the ack we just wrote reaches the dashboard first — after this the process
 * that would report anything is gone.
 *
 * No `--update-env` (same as gateway-watch.sh): it would overwrite the app's
 * stored env with whatever this shell has. A change to ecosystem.config.cjs
 * itself is therefore NOT picked up by a restart — that still needs
 * `pm2 start apps/gateway/ecosystem.config.cjs` by hand on the host.
 */
function scheduleGatewayRestart(app: string): void {
  const child = spawn('bash', ['-lc', `sleep ${RESTART_DELAY_SEC}; pm2 restart ${q(app)}`], {
    detached: true,
    stdio: 'ignore',
  });
  // A ChildProcess that emits 'error' with nobody listening throws, and an
  // uncaught throw here would take down the gateway for real rather than
  // restarting it. Log and let the request stand as acked.
  child.on('error', (e) => console.error('[machine-req] could not spawn the restart:', e.message));
  child.unref();
}

async function runUpdateGateway(id: string): Promise<void> {
  const self = await pm2Self();
  if (!self) {
    await api.ackMachineRequest({
      id,
      status: 'error',
      error: 'this gateway is not a pm2 app (or pm2 is not on its PATH) — update it on the host',
    });
    return;
  }
  const { app, repo } = self;

  const before = await sh(`git -C ${q(repo)} rev-parse HEAD`, GIT_TIMEOUT_MS);
  // --ff-only: on a machine nobody is looking at, refusing is the right answer
  // to a diverged or dirty checkout. A merge commit invented here is one nobody
  // would ever review.
  const pull = await sh(`git -C ${q(repo)} pull --ff-only`, GIT_TIMEOUT_MS);
  if (!pull.ok) {
    await api.ackMachineRequest({
      id,
      status: 'error',
      output: pull.out.slice(-4000),
      error: pull.timedOut ? 'git pull timed out' : 'git pull --ff-only failed',
    });
    return;
  }
  const after = await sh(`git -C ${q(repo)} rev-parse HEAD`, GIT_TIMEOUT_MS);

  // Nothing new → nothing to restart. A restart costs every live session on
  // this machine its in-flight turn, so it is never paid for a no-op.
  if (before.ok && after.ok && before.out === after.out) {
    await api.ackMachineRequest({
      id,
      status: 'done',
      output: `already up to date at ${after.out.slice(0, 8)} — not restarting`,
    });
    console.log('[machine-req] update-gateway → already up to date');
    return;
  }

  const lines: string[] = [pull.out];
  if (before.ok && after.ok) {
    const log = await sh(
      `git -C ${q(repo)} log --oneline ${q(before.out)}..${q(after.out)}`,
      GIT_TIMEOUT_MS,
    );
    if (log.ok && log.out) lines.push('', log.out);
  }

  // Only when the dependency manifests actually moved — npm install is minutes.
  const deps = before.ok && after.ok
    ? await sh(
        `git -C ${q(repo)} diff --name-only ${q(before.out)} ${q(after.out)} -- package-lock.json package.json 'apps/*/package.json' 'packages/*/package.json'`,
        GIT_TIMEOUT_MS,
      )
    : { ok: true, out: 'package-lock.json', timedOut: false };
  if (deps.out.trim()) {
    // NODE_ENV=development on purpose: pm2 runs this gateway with
    // NODE_ENV=production, under which npm PRUNES devDependencies — and the
    // failure surfaces much later as a build or typecheck that names something
    // unrelated. The install must not depend on who called it.
    const install = await execCapture(
      'bash',
      ['-lc', `cd ${q(repo)} && npm install --no-audit --no-fund`],
      { timeoutMs: NPM_TIMEOUT_MS, env: { ...process.env, NODE_ENV: 'development' } },
    );
    const out = [install.stdout, install.stderr].filter(Boolean).join('\n').trim();
    if (install.status !== 0 || install.timedOut) {
      await api.ackMachineRequest({
        id,
        status: 'error',
        output: [...lines, '', out].join('\n').slice(-4000),
        error: install.timedOut ? 'npm install timed out' : `npm install exit ${install.status}`,
      });
      return;
    }
    lines.push('', 'deps changed → npm install ok');
  }

  lines.push('', `restarting ${app} in ${RESTART_DELAY_SEC}s`);
  await api.ackMachineRequest({ id, status: 'done', output: lines.join('\n').trim().slice(-4000) });
  console.log(`[machine-req] update-gateway → ${after.out.slice(0, 8)}, restarting`);
  scheduleGatewayRestart(app);
}

async function runRestartGateway(id: string): Promise<void> {
  const self = await pm2Self();
  if (!self) {
    await api.ackMachineRequest({
      id,
      status: 'error',
      error: 'this gateway is not a pm2 app (or pm2 is not on its PATH) — restart it on the host',
    });
    return;
  }
  // Acked BEFORE the restart is scheduled, not after: a moment later there is
  // no process left to report with, and a row stuck on `running` would block
  // the next request.
  await api.ackMachineRequest({
    id,
    status: 'done',
    output: `restarting ${self.app} in ${RESTART_DELAY_SEC}s — sessions on this machine lose the turn they are mid-way through and resume on their next message`,
  });
  console.log(`[machine-req] restart-gateway → ${self.app}`);
  scheduleGatewayRestart(self.app);
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
        else if (r.kind === 'update-gateway') await runUpdateGateway(r.id);
        else if (r.kind === 'restart-gateway') await runRestartGateway(r.id);
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
