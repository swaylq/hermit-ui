// Which pi session file belongs to which hermit chat session.
//
// pi keeps every session as an append-only JSONL under
// `~/.pi/agent/sessions/<encoded-cwd>/`, and `pi --session <path>` reattaches to
// one. The piece that was missing is this pointer: nothing wrote down that
// hermit session X had been talking to pi session Y, so every spawn started an
// empty session. A gateway restart — which developing pi requires — handed the
// next message a child with none of the conversation in it while the dashboard
// still showed the whole transcript, and it did so silently: the eviction notice
// in pi-rpc.ts only fires for a child that dies while the gateway lives, and a
// restart takes the in-memory handle map with it.
//
// Machine-local on purpose. The session file is on this machine's disk, so a
// pointer synced to another host would name a file that is not there. The
// dashboard stays the transcript's home; this is only the local handle to the
// live context.

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_ROOT } from '../config';

/** Which engine wrote a session — they cannot read each other's files. */
export type PiEngine = 'pi' | 'omp';

export type PiSessionPointer = {
  /** Absolute path to the engine's session JSONL — what `--session`/`--resume` is given. */
  file: string;
  /** The engine's own session id. Reported back by getState(), so it doubles as the check that the reattach took. */
  piSessionId: string;
  /** The cwd the child ran in; both engines scope their session directories by it. */
  cwd: string;
  /**
   * Which engine owns the file.
   *
   * Absent means 'pi' — pointers written before omp learned to resume, and the
   * only shape that existed then. It matters because a session can change
   * engine under the user (a mode switch does exactly that, see runtimeFor):
   * handing an omp JSONL to `pi --session` reattaches nothing at best, so a
   * pointer from the other engine must read as "no session to resume" rather
   * than as a file to try.
   */
  engine?: PiEngine;
  /**
   * Set once a turn has completed and pi has actually written the file.
   *
   * pi reports its session file the moment the child is up but only persists it
   * when there is something to persist — a session that never got a turn leaves
   * no file at all (measured, not assumed). Without this flag "the file is
   * missing" is ambiguous between "a conversation was lost" and "there was
   * never a conversation", and the runtime would announce a lost thread to
   * every user whose previous child died before it answered anything.
   */
  flushed?: boolean;
  updatedAt: string;
};

type Store = Record<string, PiSessionPointer>;

/**
 * Kept next to the machine's other hermit-local state (ops-hosts.json,
 * pi-modes/), not in the repo and not in the DB.
 */
export function piSessionStorePath(): string {
  return path.join(AGENTS_ROOT, '.hermit', 'pi-sessions.json');
}

// One entry is ~200 bytes and only sessions that actually ran pi get one, but
// the file is read on every pi spawn, so it is capped rather than left to grow
// for the life of the machine. Oldest-first eviction: a session nobody has
// touched in 500 sessions' time is not the one about to be resumed.
export const MAX_ENTRIES = 500;

function readStore(file: string): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    // Missing is the ordinary first-run case, and a corrupt file is not worth a
    // crash: a lost pointer costs one conversation its context, while throwing
    // here would take down every pi spawn on the machine.
    return {};
  }
}

/**
 * Drop pointers whose session file is gone — they can never reattach, so
 * keeping them only defers the failure to spawn time.
 *
 * Deliberately NOT applied to the entry being written: pi reports its session
 * file from getState() the moment the child is up, which can be before it has
 * written the first entry to disk. Pruning on the way in would throw away
 * exactly the pointer we just learned, every time, and resume would never work
 * once.
 */
function prune(store: Store): Store {
  const kept: Store = {};
  for (const [id, p] of Object.entries(store)) {
    if (p?.file && fs.existsSync(p.file)) kept[id] = p;
  }
  return kept;
}

function writeStore(file: string, store: Store): void {
  const entries = Object.entries(store)
    .sort((a, b) => (b[1].updatedAt ?? '').localeCompare(a[1].updatedAt ?? ''))
    .slice(0, MAX_ENTRIES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Temp + rename, because a gateway killed mid-write must not leave truncated
  // JSON behind — that reads as "no session has a pointer" for every session at
  // once, which is precisely the amnesia this file exists to prevent.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * The pi session this hermit session last owned, or null if it never had one.
 *
 * Returned even when the file is missing — callers need to tell "new session,
 * nothing to carry over" (null) apart from "had a thread and lost it", which is
 * the case worth telling the user about.
 */
export function readPiSession(sessionId: string, file = piSessionStorePath()): PiSessionPointer | null {
  return readStore(file)[sessionId] ?? null;
}

/** The engine a pointer belongs to, defaulting the pre-omp shape to 'pi'. */
export function pointerEngine(pointer: PiSessionPointer): PiEngine {
  return pointer.engine === 'omp' ? 'omp' : 'pi';
}

/**
 * The session this hermit session can actually be put back onto.
 *
 * Null both when there was never one and when its file is gone; the caller
 * separates those with readPiSession, because only the second is a thread that
 * was lost and worth reporting.
 *
 * `opts.engine` filters to pointers that engine can actually open. Callers that
 * pass it get null for a pointer left by the other engine, which is the same
 * "nothing to resume" the very first boot sees — correct, and quiet.
 */
export function resumablePiSession(
  sessionId: string,
  file = piSessionStorePath(),
  opts: { engine?: PiEngine } = {},
): PiSessionPointer | null {
  const pointer = readPiSession(sessionId, file);
  if (!pointer?.file) return null;
  if (opts.engine && pointerEngine(pointer) !== opts.engine) return null;
  return fs.existsSync(pointer.file) ? pointer : null;
}

/** Record (or refresh) the pi session a child is now serving. */
export function rememberPiSession(
  sessionId: string,
  pointer: Omit<PiSessionPointer, 'updatedAt'> & { updatedAt?: string },
  file = piSessionStorePath(),
): void {
  const store = prune(readStore(file));
  store[sessionId] = { ...pointer, updatedAt: pointer.updatedAt ?? new Date().toISOString() };
  writeStore(file, store);
}

/** Drop a pointer. Used when a session is deleted, not when its child dies. */
export function forgetPiSession(sessionId: string, file = piSessionStorePath()): void {
  const store = readStore(file);
  if (!(sessionId in store)) return;
  delete store[sessionId];
  writeStore(file, prune(store));
}
