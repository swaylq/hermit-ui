// Which backend runs a chat session.
//
// Resolved on the dashboard so the gateway receives one already-decided answer
// and never has to know the fallback chain. See docs/pi-runtime-design.md.

export type RuntimeChoice = {
  runtime: string;
  runtimeProvider: string | null;
  runtimeModel: string | null;
};

type Level = {
  runtime?: string | null;
  runtimeProvider?: string | null;
  runtimeModel?: string | null;
} | null | undefined;

export const DEFAULT_RUNTIME = 'claude-tmux';

/**
 * session's own choice > agent's default > claude-tmux.
 *
 * provider/model follow the level that actually chose the runtime. A session
 * that switches to a different backend than its agent must NOT inherit the
 * agent's provider/model — those describe a different backend and would be
 * nonsense (or, worse, silently point pi at a claude model name). When both
 * levels agree on the backend, the session may leave provider/model unset and
 * inherit the agent's, which is the common "same backend, default model" case.
 */
export function resolveRuntime(session: Level, agent: Level): RuntimeChoice {
  const runtime = session?.runtime ?? agent?.runtime ?? DEFAULT_RUNTIME;
  const inheritable = !session?.runtime || session.runtime === agent?.runtime;

  return {
    runtime,
    runtimeProvider: session?.runtimeProvider ?? (inheritable ? agent?.runtimeProvider ?? null : null),
    runtimeModel: session?.runtimeModel ?? (inheritable ? agent?.runtimeModel ?? null : null),
  };
}
