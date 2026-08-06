// Which backend runs a chat session.
//
// Resolved on the dashboard so the gateway receives one already-decided answer
// and never has to know the fallback chain. See docs/pi-runtime-design.md.

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
export const DEFAULT_PI_MODE = 'coding';

/**
 * Backends that run as a child process off a mode recipe.
 *
 * Duplicated from lib/runtime-labels' isModeBackend rather than imported: this
 * module is a pure function with its own node:test suite, and keeping it free
 * of path-aliased imports keeps that suite runnable without Next's resolver.
 * Both lists must move together when a backend is added.
 */
function isModeBackend(runtime: string): boolean {
  return runtime === 'pi-rpc' || runtime === 'omp-rpc';
}

/**
 * session's own choice > agent's default > claude-tmux.
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
 */
export function resolveRuntime(session: Level, agent: Level): RuntimeChoice {
  const runtime = session?.runtime ?? agent?.runtime ?? DEFAULT_RUNTIME;
  const inheritable = !session?.runtime || session.runtime === agent?.runtime;

  return {
    runtime,
    runtimeProvider: session?.runtimeProvider ?? (inheritable ? agent?.runtimeProvider ?? null : null),
    runtimeModel: session?.runtimeModel ?? (inheritable ? agent?.runtimeModel ?? null : null),
    runtimeMode: !isModeBackend(runtime)
      ? null
      : session?.runtimeMode ?? (inheritable ? agent?.runtimeMode ?? null : null) ?? DEFAULT_PI_MODE,
  };
}
