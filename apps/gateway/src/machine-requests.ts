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
// An op holding the queue longer than this has hung, not slowed down.
const BUSY_CEILING_MS = 20 * 60_000;

let busy = false;
let busySince = 0;
// Set once a restart of THIS process is armed. Everything after that point is
// work that will be killed part-way through, and a `git pull` or `npm install`
// killed part-way through is how you get an .git/index.lock or a half-written
// node_modules — i.e. a machine that needs an SSH session to recover.
let restartArmed = false;

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

/**
 * Ack that cannot throw. Every caller below is about to do something it must do
 * whether or not the dashboard heard about it, and an ack that rejects used to
 * mean both no result AND no action — the request row stranded on `running`,
 * and the restart it was reporting never armed.
 */
async function ack(
  id: string,
  fields: { status: 'running' | 'done' | 'error'; output?: string; error?: string },
): Promise<void> {
  try {
    await api.ackMachineRequest({ id, ...fields });
  } catch (e) {
    console.error('[machine-req] ack failed:', e instanceof Error ? e.message : String(e));
  }
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
 * Detached, and delayed a few seconds — NOT to get the ack out (that call is
 * already awaited and answered by the time we get here) but to let the tick
 * that called this unwind first. Its output goes to a file because in a second
 * or two there is no process left to report a failed restart with, and "pm2 was
 * not on the PATH" has to be findable afterwards.
 *
 * No `--update-env` (same as gateway-watch.sh): it would overwrite the app's
 * stored env with whatever this shell has. A change to ecosystem.config.cjs
 * itself is therefore NOT picked up by a restart — that still needs
 * `pm2 start apps/gateway/ecosystem.config.cjs` by hand on the host.
 */
function scheduleGatewayRestart(app: string, repo: string): void {
  restartArmed = true;
  const log = `${repo}/apps/gateway/logs/self-restart.log`;
  const child = spawn(
    'bash',
    ['-lc', `sleep ${RESTART_DELAY_SEC}; pm2 restart ${q(app)} >> ${q(log)} 2>&1`],
    { detached: true, stdio: 'ignore' },
  );
  // A ChildProcess that emits 'error' with nobody listening throws, and an
  // uncaught throw here would take down the gateway for real rather than
  // restarting it. Log and let the request stand as acked.
  child.on('error', (e) => console.error('[machine-req] could not spawn the restart:', e.message));
  child.unref();
}

/**
 * This checkout's HEAD, pulled OUT of the command's output rather than taken as
 * the whole of it. `sh` runs a login shell and joins stdout with stderr, and on
 * a box with a motd, a `You have mail`, or an nvm warning that stream is the
 * SHA plus whatever else the shell felt like saying. Comparing those blobs to
 * decide "did anything change?" would answer yes on an unchanged repo whenever
 * the banner carries a clock — and the price of a wrong yes is every session on
 * the machine losing its turn to a pointless restart.
 *
 * null means the question could not be answered, which is never treated as
 * licence to restart.
 */
async function headSha(repo: string): Promise<string | null> {
  const r = await sh(`git -C ${q(repo)} rev-parse HEAD`, GIT_TIMEOUT_MS);
  const m = r.ok ? /\b[0-9a-f]{40}\b/.exec(r.out) : null;
  return m ? m[0] : null;
}

async function runUpdateGateway(id: string): Promise<void> {
  const self = await pm2Self();
  if (!self) {
    await ack(id, {
      status: 'error',
      error: 'this gateway is not a pm2 app (or pm2 is not on its PATH) — update it on the host',
    });
    return;
  }
  const { app, repo } = self;

  const before = await headSha(repo);
  if (!before) {
    await ack(id, { status: 'error', error: `not a readable git checkout: ${repo}` });
    return;
  }
  const branch = await sh(`git -C ${q(repo)} rev-parse --abbrev-ref HEAD`, GIT_TIMEOUT_MS);

  // `origin main` spelled out, exactly as scripts/vps-deploy.sh does it. Without
  // it "update to latest" means "fast-forward whatever branch this checkout
  // happens to sit on", and this fleet leaves checkouts on wt/* branches all
  // day. --ff-only so a diverged or dirty checkout is refused rather than
  // resolved by a merge commit nobody would ever review.
  const pull = await sh(`git -C ${q(repo)} pull --ff-only origin main`, GIT_TIMEOUT_MS);
  if (!pull.ok) {
    await ack(id, {
      status: 'error',
      output: [`on branch ${branch.out || '?'}`, pull.out].join('\n').slice(-4000),
      error: pull.timedOut ? 'git pull timed out' : 'git pull --ff-only origin main failed',
    });
    return;
  }
  const after = await headSha(repo);
  if (!after) {
    await ack(id, { status: 'error', output: pull.out.slice(-4000), error: 'could not read HEAD after the pull' });
    return;
  }

  // Nothing new → nothing to restart. A restart costs every live session on
  // this machine the turn it is mid-way through, and that is not a price to pay
  // for a no-op.
  if (before === after) {
    await ack(id, { status: 'done', output: `already up to date at ${after.slice(0, 8)} — not restarting` });
    console.log('[machine-req] update-gateway → already up to date');
    return;
  }

  const lines: string[] = [`${before.slice(0, 8)} → ${after.slice(0, 8)} on ${branch.out || '?'}`];
  const log = await sh(`git -C ${q(repo)} log --oneline ${q(before)}..${q(after)}`, GIT_TIMEOUT_MS);
  if (log.ok && log.out) lines.push('', log.out);

  // Only when the dependency manifests actually moved — npm install is minutes.
  const deps = await sh(
    `git -C ${q(repo)} diff --name-only ${q(before)} ${q(after)} -- package-lock.json package.json 'apps/*/package.json' 'packages/*/package.json'`,
    GIT_TIMEOUT_MS,
  );
  if (!deps.ok || deps.out.trim()) {
    // NODE_ENV=development on purpose: pm2 runs this gateway with
    // NODE_ENV=production, under which npm PRUNES devDependencies — and that
    // surfaces much later as a build or typecheck failure naming something
    // unrelated. What gets installed must not depend on who called it. The git
    // vars are here for the same reason as in `sh`: a git-URL dependency must
    // fail rather than sit on a prompt until the timeout.
    const install = await execCapture('bash', ['-lc', `cd ${q(repo)} && npm install --no-audit --no-fund`], {
      timeoutMs: NPM_TIMEOUT_MS,
      env: { ...process.env, NODE_ENV: 'development', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
    });
    const out = [install.stdout, install.stderr].filter(Boolean).join('\n').trim();
    if (install.status !== 0 || install.timedOut) {
      await ack(id, {
        status: 'error',
        output: [...lines, '', out].join('\n').slice(-4000),
        error: install.timedOut ? 'npm install timed out' : `npm install exit ${install.status}`,
      });
      return;
    }
    lines.push('', deps.ok ? 'deps changed → npm install ok' : 'could not diff the manifests → npm install ok');
  }

  lines.push('', `restarting ${app} in ${RESTART_DELAY_SEC}s`);
  await ack(id, { status: 'done', output: lines.join('\n').trim().slice(-4000) });
  console.log(`[machine-req] update-gateway → ${after.slice(0, 8)}, restarting`);
  scheduleGatewayRestart(app, repo);
}

async function runRestartGateway(id: string): Promise<void> {
  const self = await pm2Self();
  if (!self) {
    await ack(id, {
      status: 'error',
      error: 'this gateway is not a pm2 app (or pm2 is not on its PATH) — restart it on the host',
    });
    return;
  }
  // Acked BEFORE the restart is armed, not after: a moment later there is no
  // process left to report with. `ack` swallows its own failure precisely here —
  // a dashboard that did not hear about the restart is a cosmetic problem, a
  // restart that never happened because the bookkeeping call failed is not.
  await ack(id, {
    status: 'done',
    output: `restarting ${self.app} in ${RESTART_DELAY_SEC}s — sessions on this machine lose the turn they are mid-way through and resume on their next message`,
  });
  console.log(`[machine-req] restart-gateway → ${self.app}`);
  scheduleGatewayRestart(self.app, self.repo);
}

export async function machineRequestTick(): Promise<void> {
  // Once a restart of this process is armed, everything else in the queue would
  // be started only to be killed part-way through. Whatever is left stays
  // pending and is picked up by the gateway that comes back.
  if (restartArmed) return;
  if (busy) {
    // ops run for minutes (an upgrade download, N × the restart gap) — never
    // overlap them. The ceiling is the escape hatch: an op that hangs past it
    // has stopped being work in progress, and holding the flag for good would
    // mean the machine can no longer be told to restart either, which is the
    // one instruction that fixes a wedged one.
    if (Date.now() - busySince < BUSY_CEILING_MS) return;
    console.error(`[machine-req] an op has held the queue for ${Math.round((Date.now() - busySince) / 60_000)}min — releasing it`);
  }
  let reqs: Array<{ id: string; kind: string }>;
  try {
    reqs = await api.pollMachineRequests();
  } catch (e) {
    console.error('[machine-req] poll failed:', e);
    return;
  }
  if (reqs.length === 0) return;

  busy = true;
  busySince = Date.now();
  try {
    for (const r of reqs) {
      try {
        await ack(r.id, { status: 'running' });
        if (r.kind === 'upgrade-claude') await runUpgrade(r.id);
        else if (r.kind === 'restart-all-sessions') await runRestartAll(r.id);
        else if (r.kind === 'update-gateway') await runUpdateGateway(r.id);
        else if (r.kind === 'restart-gateway') await runRestartGateway(r.id);
        else await ack(r.id, { status: 'error', error: `unknown kind: ${r.kind}` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[machine-req] ${r.kind} failed:`, msg);
        await ack(r.id, { status: 'error', error: msg });
      }
      // Both gateway ops end by arming a restart of this very process. Anything
      // started after that point gets SIGKILLed a few seconds in — a git pull
      // interrupted mid-checkout leaves .git/index.lock behind, and an npm
      // install interrupted mid-write can leave the node_modules/.bin/tsx that
      // pm2 execs as this app's script. Both need an SSH session to undo.
      if (restartArmed) break;
    }
  } finally {
    busy = false;
  }
}
