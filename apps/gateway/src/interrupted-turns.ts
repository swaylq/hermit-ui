// interrupted-turns.ts — a session that was working when the gateway stopped
// gets picked back up by the next one, instead of waiting for a human to notice.
//
// The gap this closes: `chatTick`'s re-attach loop skips every non-tmux session
// (`if (!tmuxOwnsSession(s)) continue;`), so after a restart a claude-sdk
// session had no child, no transcript tail and no activity until somebody sent
// it another message. For a conversation with a person waiting that is merely
// slow — their next message wakes it with `--resume` and the history intact.
// For a session running a long autonomous job (a cron turn, a build, a review
// pass nobody is watching) it is fatal and SILENT: no restart, no error, no
// alert, just a session that stops. Cron runs have a sweep on the dashboard
// side; ordinary sessions had nothing.
//
// How it knows who was working: a local file, written on turn-boundary
// transitions. Not the DB — `pollChatPending` does not return `state`, and the
// startup snapshot would overwrite it before we could read it anyway. Not a
// guess from the transcript either; the runtime already announces boundaries
// authoritatively (runtime/turn-boundary.ts), and every pane-era attempt to
// infer "is it working" from file shape is in the design doc's table of things
// that went wrong.
//
// What it deliberately does NOT do: replay the user's message. That turn may
// have already sent an email, pushed a commit or deleted something before it
// was cut, and re-running it blind would do those twice. The session is resumed
// with its transcript intact — including the interruption Layer 0 now records
// honestly — and told what happened, so the model can see its own half-finished
// work and decide what actually needs redoing. That is what a person would say
// to a colleague whose laptop died mid-task, and it is the only version of this
// that is safe to do automatically.

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_ROOT } from './config';
import { api } from './api';
import { onTurnBoundary } from './runtime/turn-boundary';
import { ensureSessionBackend } from './chat-runner';
import { sessionHostEnabled, hostSessions, hostHolds } from './runtime/session-host-client';

/** Next to the machine's other hermit-local state, same as pi-sessions.json. */
export function inFlightTurnsPath(): string {
  return path.join(AGENTS_ROOT, '.hermit', 'in-flight-turns.json');
}

interface Store {
  /** Session ids that had a turn running, → when it started (ISO). */
  sessions: Record<string, string>;
}

/**
 * How long a gateway may have been away and still resume anything.
 *
 * Keyed off the FILE's age, not the turn's: a turn that legitimately ran for
 * forty minutes and was cut a minute ago should come back, and an overnight
 * reboot should not wake eighteen sessions at 4.8 GB to continue work the
 * person has long since moved on from.
 */
const MAX_DOWNTIME_MS = Number(process.env.HERMIT_RESUME_MAX_DOWNTIME_MS ?? 15 * 60_000);

/**
 * Blast-radius cap. Each resumed claude child is ~300 MB and one model turn of
 * quota, so "resume everything" on a machine that lost twenty sessions is a
 * decision worth refusing to make automatically.
 */
const MAX_RESUMES = Number(process.env.HERMIT_RESUME_MAX_SESSIONS ?? 8);

const NUDGE =
  '[gateway] 网关刚重启，打断了你上一轮的工作。对话历史是完整的：先看一眼上一轮做到哪一步了——' +
  '尤其是已经跑过的命令和已经写出去的文件——确认哪些不需要重做，然后接着做完。' +
  '如果那一轮其实已经做完了，回一句「已完成」即可，不要重复执行。';

function readStore(file: string): { store: Store; mtimeMs: number } | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const mtimeMs = fs.statSync(file).mtimeMs;
    const parsed = JSON.parse(raw) as unknown;
    const sessions = (parsed as Store)?.sessions;
    if (!sessions || typeof sessions !== 'object') return null;
    return { store: { sessions }, mtimeMs };
  } catch {
    // Missing is the ordinary first-run case. Corrupt is not worth a crash: the
    // cost of ignoring it is that one restart does not resume, and the cost of
    // throwing is that the gateway does not start.
    return null;
  }
}

function writeStore(file: string, store: Store): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    // Never throw: this runs inside the turn-boundary listener, which runs
    // inside the SDK message loop.
    console.warn('[interrupted-turns] could not record in-flight turns:', (e as Error)?.message ?? e);
  }
}

/** Sessions this gateway currently believes are mid-turn. */
const working = new Map<string, string>();

let frozen = false;

/**
 * Stop mirroring boundaries. Called the moment a stop signal arrives, because
 * the drain is about to `interrupt()` every cut turn and each interrupt
 * truthfully announces its session as idle — which would erase, one by one,
 * exactly the list the next gateway needs. From here the drain's own report is
 * the authority; see recordInterruptedTurns.
 */
export function freezeInFlightTurns(): void {
  frozen = true;
}

/**
 * Overwrite the record with the sessions the drain actually cut.
 *
 * More accurate than the tracked set in both directions: a turn that FINISHED
 * during the drain's wait is not in it (so it is not woken up to be told about
 * an interruption that never happened), and a turn cut at the deadline is,
 * even though its interrupt announced it idle a moment later.
 */
export function recordInterruptedTurns(sessionIds: string[], file = inFlightTurnsPath()): void {
  if (sessionIds.length === 0) {
    try { fs.rmSync(file, { force: true }); } catch { /* nothing to clear */ }
    return;
  }
  const at = new Date().toISOString();
  writeStore(file, { sessions: Object.fromEntries(sessionIds.map((id) => [id, at])) });
}

/**
 * Start mirroring turn boundaries to disk. Returns the unsubscribe.
 *
 * Writes only on a transition — `notifyTurnBoundary` also fires when the tool a
 * turn is running changes, and those must not each cost a file write. Two
 * writes per turn, synchronously: a debounce here would mean the crash we are
 * insuring against could land inside the debounce window, which is exactly the
 * shape of the bug this whole change set started from.
 */
export function startTrackingInFlightTurns(file = inFlightTurnsPath()): () => void {
  return onTurnBoundary((b) => {
    if (frozen) return;
    const had = working.has(b.sessionId);
    if (b.working === had) return;
    if (b.working) working.set(b.sessionId, new Date().toISOString());
    else working.delete(b.sessionId);
    writeStore(file, { sessions: Object.fromEntries(working) });
  });
}

export interface InterruptedTurns {
  sessionIds: string[];
  /** How long ago the previous gateway last touched the file. */
  stoppedAgoMs: number;
}

/**
 * Who was mid-turn when the previous gateway stopped, and how long ago.
 *
 * Consumes the file: a resume that fails must not be retried on every restart
 * forever, and the next boundary rewrites it from the live set anyway.
 */
export function takeInterruptedTurns(file = inFlightTurnsPath(), now = Date.now()): InterruptedTurns {
  const read = readStore(file);
  if (!read) return { sessionIds: [], stoppedAgoMs: 0 };
  try {
    fs.rmSync(file, { force: true });
  } catch { /* a file we cannot delete is one we will read again; the age gate still bounds it */ }
  return {
    sessionIds: Object.keys(read.store.sessions),
    stoppedAgoMs: Math.max(0, now - read.mtimeMs),
  };
}

/**
 * The startup pass. Resume the sessions the last gateway was in the middle of,
 * and tell each one what happened.
 *
 * Runs after the orphan reaper (nothing may resume while a previous child could
 * still be writing the same transcript) and before the first session snapshot
 * (which would otherwise report them as dead a moment before they come back).
 */
export async function recoverInterruptedTurns(): Promise<void> {
  if (process.env.HERMIT_RESUME_AFTER_RESTART === '0') {
    return;
  }
  const { sessionIds, stoppedAgoMs } = takeInterruptedTurns();
  if (sessionIds.length === 0) return;

  if (stoppedAgoMs > MAX_DOWNTIME_MS) {
    console.log(
      `[interrupted-turns] ${sessionIds.length} session(s) were mid-turn, but the gateway has been away ` +
      `${Math.round(stoppedAgoMs / 60_000)}m — leaving them asleep, the next message wakes them`,
    );
    return;
  }

  const { sessions } = await api.pollChatPending();
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const targets = sessionIds.filter((id) => byId.has(id));
  const skipped = sessionIds.length - targets.length;
  if (skipped > 0) {
    // Closed, trashed, or moved to another machine between the two gateways.
    console.log(`[interrupted-turns] ${skipped} recorded session(s) no longer exist here`);
  }
  if (targets.length > MAX_RESUMES) {
    console.warn(
      `[interrupted-turns] ${targets.length} sessions were mid-turn, resuming the first ${MAX_RESUMES}; ` +
      'the rest wake on their next message',
    );
  }

  let resumed = 0;
  for (const id of targets.slice(0, MAX_RESUMES)) {
    const row = byId.get(id)!;
    try {
      // A session the host is still running was never cut, whatever the tracker
      // file says. It says something because the file is written on turn
      // boundaries and a SIGKILLed gateway never got to correct it — reattach
      // already picked this session up a moment ago. Nudging it here would tell
      // a conversation it was interrupted when it was not, and spend a turn of
      // quota saying so.
      if (await hostHolds(id)) continue;
      const started = await ensureSessionBackend(row);
      if (!started) continue; // a pane; it never died in the first place
      // If it is somehow already busy, the record was stale and the child is
      // live — injecting a turn into it would queue behind real work and say
      // something confusing about a restart that did not touch it.
      if (await started.runtime.isWorking(started.handle)) continue;
      if (await started.runtime.submit(started.handle, NUDGE, [])) resumed++;
    } catch (e) {
      console.error(`[interrupted-turns] could not resume ${id.slice(0, 8)}:`, (e as Error)?.message ?? e);
    }
  }
  console.log(`[interrupted-turns] resumed ${resumed}/${targets.length} session(s) cut by the last restart`);
}

/**
 * Reattach to the sessions a session host kept running through the restart.
 *
 * Without this, the session host makes things WORSE for exactly the case it was
 * built for. A long autonomous turn now survives the restart — but the new
 * gateway is not attached to it, so its output goes only to the transcript and
 * the conversation on screen stays frozen until somebody happens to send a
 * message. A turn that runs unwatched is not much better than one that stopped.
 *
 * Cheap, unlike the resume in recoverInterruptedTurns: nothing is spawned. The
 * shim adopts the child the host already holds, and the runtime's transcript
 * tail replays whatever landed while nobody was listening.
 */
export async function reattachHostSessions(): Promise<void> {
  if (!sessionHostEnabled()) return;
  const held = await hostSessions();
  if (held === null) {
    console.warn(
      '[session-host] HERMIT_SESSION_HOST=1 but no host is answering. Sessions will not survive a restart. ' +
      'Start it with: pm2 startOrRestart apps/gateway/ecosystem-session-host.config.cjs && pm2 save',
    );
    return;
  }
  if (held.length === 0) return;

  const { sessions } = await api.pollChatPending();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let back = 0;
  for (const h of held) {
    const row = byId.get(h.sessionId);
    if (!row) continue; // closed or moved while we were away; the host's idle sweep gets the child
    try {
      if (await ensureSessionBackend(row)) back++;
    } catch (e) {
      console.error(`[session-host] could not reattach ${h.sessionId.slice(0, 8)}:`, (e as Error)?.message ?? e);
    }
  }
  console.log(`[session-host] reattached ${back}/${held.length} session(s) that ran straight through the restart`);
}
