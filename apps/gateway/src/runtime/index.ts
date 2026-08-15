import type { AgentRuntime } from './types';
import { PiRpcRuntime } from './pi-rpc';
import { OmpRpcRuntime } from './omp-rpc';
import { CodexExecRuntime } from './codex-exec';
import { DshExecRuntime } from './dsh-exec';
import { resolveMode } from './pi-modes';

const piRuntime = new PiRpcRuntime();
const ompRuntime = new OmpRpcRuntime();
const codexRuntime = new CodexExecRuntime();
const dshRuntime = new DshExecRuntime();

/**
 * Pick the backend for a session.
 *
 * 'claude-tmux' (and anything unrecognised) returns null so the caller keeps
 * its existing inline tmux path, which this deliberately does not touch — that
 * path is the fleet's critical path and the only one that bills against Claude
 * Max's Interactive bucket.
 *
 * 'codex-exec' and 'dsh-exec' are their own backends and take no mode: neither
 * has an equivalent of a pi mode (no spawn recipe, no tool allowlist we
 * compose — dsh composes its own from its profile), so there is nothing for
 * one to select and resolveRuntime already nulls it out upstream.
 *
 * There is one *backend* in the pi family and two *engines* under it. Which
 * engine runs is declared by the MODE, not chosen separately: from the user's
 * side "pi or omp" and "coding or ops" are one decision, and a mode already
 * pins the model, the prompt and the tool list, so the engine belongs with
 * them. It also keeps one auth configuration — Settings → Pi Runtime, including
 * the Claude-subscription option — serving both, instead of a second backend
 * growing a parallel set.
 *
 * An unknown or absent mode resolves to the default mode. The default is omp
 * (oh-my-pi — the full-tool engine), so a pi session with no mode stated runs
 * omp rather than bare pi.
 *
 * `mode` is REQUIRED, though it accepts null/undefined. It used to be optional,
 * and the session-snapshot probe quietly omitted it — so every omp session was
 * probed with pi's runtime, found no handle in pi's live map, and reported no
 * context at all while its child ran fine. A caller that has no mode must say so
 * explicitly rather than by leaving the argument off.
 */
export function runtimeFor(
  kind: string | null | undefined,
  mode: string | null | undefined,
): AgentRuntime | null {
  if (kind === 'codex-exec') return codexRuntime;
  if (kind === 'dsh-exec') return dshRuntime;
  if (kind !== 'pi-rpc') return null;
  return resolveMode(mode)?.engine === 'omp' ? ompRuntime : piRuntime;
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
  return [piRuntime, ompRuntime, codexRuntime, dshRuntime];
}

export type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
