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
 * A short-lived third backend, folded back into pi as an engine chosen by the
 * mode. Mapped rather than dropped so a session created during that window
 * still resolves to something that runs, instead of silently falling through
 * to the tmux path.
 */
function normalizeRuntime(runtime: string): string {
  return runtime === 'omp-rpc' ? 'pi-rpc' : runtime;
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
  const runtime = normalizeRuntime(session?.runtime ?? agent?.runtime ?? DEFAULT_RUNTIME);
  const inheritable = !session?.runtime || session.runtime === agent?.runtime;

  return {
    runtime,
    runtimeProvider: session?.runtimeProvider ?? (inheritable ? agent?.runtimeProvider ?? null : null),
    runtimeModel: session?.runtimeModel ?? (inheritable ? agent?.runtimeModel ?? null : null),
    runtimeMode: runtime !== 'pi-rpc'
      ? null
      : session?.runtimeMode ?? (inheritable ? agent?.runtimeMode ?? null : null) ?? DEFAULT_PI_MODE,
  };
}
