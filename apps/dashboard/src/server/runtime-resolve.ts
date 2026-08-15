// Which backend runs a chat session.
//
// Resolved on the dashboard so the gateway receives one already-decided answer
// and never has to know the fallback chain. See docs/pi-runtime-design.md.

import { toBackendOption, fromBackendOption } from '@/lib/runtime-labels';
import { effectiveDefaultBackend, type BackendsConfig } from '@/lib/backend-availability';

export type RuntimeChoice = {
  runtime: string;
  runtimeProvider: string | null;
  runtimeModel: string | null;
  runtimeMode: string | null;
};

type Level = {
  runtime?: string | null;
  runtimeProvider?: string | null;
  runtimeModel?: string | null;
  runtimeMode?: string | null;
} | null | undefined;

export const DEFAULT_RUNTIME = 'claude-tmux';

/**
 * Mode when neither level names one. Only ever applied to pi sessions — see
 * the null return for claude-tmux in resolveRuntime.
 */
export const DEFAULT_PI_MODE = 'omp';

/**
 * A short-lived third backend, folded back into pi as an engine chosen by the
 * mode. Mapped rather than dropped so a session created during that window
 * still resolves to something that runs, instead of silently falling through
 * to the tmux path.
 */
function normalizeRuntime(runtime: string): string {
  return runtime === 'omp-rpc' ? 'pi-rpc' : runtime;
}

/**
 * session's own choice > agent's default (as this machine can run it) > claude-tmux.
 *
 * provider/model follow the level that actually chose the runtime. A session
 * that switches to a different backend than its agent must NOT inherit the
 * agent's provider/model — those describe a different backend and would be
 * nonsense (or, worse, silently point pi at a claude model name). When both
 * levels agree on the backend, the session may leave provider/model unset and
 * inherit the agent's, which is the common "same backend, default model" case.
 *
 * `runtimeMode` follows the same inheritance, with one extra rule: it is null
 * for anything that is not pi. A mode is a pi spawn recipe (system prompt, tool
 * allowlist, skills, extensions) and claude-tmux has no way to honour one, so
 * returning a mode there would be a value the gateway must remember to ignore.
 * Resolving it to null here means it cannot be misread downstream.
 *
 * `backends` is the machine's Settings → Backends set, and it applies to the
 * INHERITED end of the chain only: an agent defaulting to a backend the machine
 * has switched off (or to the claude-tmux floor on a machine that runs only
 * codex) inherits the first backend that machine does offer instead. A session's
 * OWN choice is never re-pointed — switching a backend off hides it from new
 * work, it does not stop what is already running on it, and reporting a running
 * claude session as codex would make every header chip a lie. Omitted = "this
 * caller has no machine in hand", which behaves exactly as before.
 */
export function resolveRuntime(
  session: Level,
  agent: Level,
  backends?: BackendsConfig | null,
): RuntimeChoice {
  // The agent's default read as a CARD, which today is 1:1 with the runtime —
  // toBackendOption keeps the mode in the signature for the next card that
  // pins one (the removed triage card did).
  const storedDefault = toBackendOption(
    normalizeRuntime(agent?.runtime ?? DEFAULT_RUNTIME),
    agent?.runtimeMode,
  );
  const usableDefault = effectiveDefaultBackend(storedDefault, backends);
  const substituted = usableDefault !== storedDefault;
  const fallback = fromBackendOption(usableDefault);

  const runtime = session?.runtime ? normalizeRuntime(session.runtime) : fallback.runtime;
  // Whether the agent's provider/model/mode describe the backend we resolved to.
  // A substitution lands on a different backend than the agent's columns were
  // written for, so it inherits nothing from them — same rule as a session that
  // picks its own backend, for the same reason.
  const inheritable = session?.runtime ? session.runtime === agent?.runtime : !substituted;

  return {
    runtime,
    runtimeProvider: session?.runtimeProvider ?? (inheritable ? agent?.runtimeProvider ?? null : null),
    runtimeModel: session?.runtimeModel ?? (inheritable ? agent?.runtimeModel ?? null : null),
    runtimeMode: runtime !== 'pi-rpc'
      ? null
      // fallback.runtimeMode would carry a mode a substituted CARD pins; no
      // current card does, so a non-inheritable chain lands on the default.
      : session?.runtimeMode ?? (inheritable ? agent?.runtimeMode ?? null : fallback.runtimeMode) ?? DEFAULT_PI_MODE,
  };
}
