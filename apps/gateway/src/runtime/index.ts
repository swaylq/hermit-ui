import type { AgentRuntime } from './types';
import { PiRpcRuntime } from './pi-rpc';
import { OmpRpcRuntime } from './omp-rpc';

const piRuntime = new PiRpcRuntime();
const ompRuntime = new OmpRpcRuntime();

/**
 * Pick the backend for a session.
 *
 * 'claude-tmux' (and anything unrecognised) returns null so the caller keeps
 * its existing inline tmux path, which this deliberately does not touch — that
 * path is the fleet's critical path and the only one that bills against Claude
 * Max's Interactive bucket.
 */
export function runtimeFor(kind: string | null | undefined): AgentRuntime | null {
  if (kind === 'pi-rpc') return piRuntime;
  if (kind === 'omp-rpc') return ompRuntime;
  return null;
}

/**
 * Every child-process backend, for the teardown paths.
 *
 * Hibernate, restart and cancel cannot tell which backend a session is on — a
 * session whose backend was just SWITCHED already reads as the new one in the
 * DB — so they act on all of them and rely on each being a no-op for a session
 * it does not own. That was already true when pi was the only one; this exists
 * so that adding omp did not mean remembering to add a second call at each of
 * the three sites, and so that adding a third never does either.
 */
export function allRuntimes(): AgentRuntime[] {
  return [piRuntime, ompRuntime];
}

export type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
