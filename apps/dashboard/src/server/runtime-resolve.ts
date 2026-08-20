// Which backend runs a chat session, and with what.
//
// Resolved on the dashboard so the gateway receives one already-decided answer
// and never has to know the fallback chain. A backend is a harness plus a
// credential (lib/backends.ts), so what the gateway is told is: which harness to
// spawn, which credential to authenticate it with, and which model and mode.
//
// See docs/backends-and-models-design.md.

import {
  backendById, backendsConfigOf, effectiveDefaultBackendId, listBackends,
  BUILT_IN_BACKENDS, DEFAULT_BACKEND_ID, type Backend, type BackendsConfig,
} from '@/lib/backends';
import {
  credentialById, defaultModelOf, modelCredentialsOf, type ModelCredential,
} from '@/lib/model-credentials';

export type RuntimeChoice = {
  /** The backend the picker shows as selected. Stored on the row. */
  backendId: string;
  /** The HARNESS to spawn — what the gateway's runtimeFor() dispatches on. */
  runtime: string;
  /** Which Settings → Models entry authenticates it; null for the built-ins. */
  runtimeCredentialId: string | null;
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

/** Everything about a machine that resolution reads. */
export type RuntimeContext = {
  backends: BackendsConfig | null;
  credentials: ModelCredential[];
};

export const DEFAULT_RUNTIME = DEFAULT_BACKEND_ID;

/**
 * Everything a Machine row contributes to resolution, in one read.
 *
 * Callers hold a cached Machine row (the gateway poll cannot afford its own
 * query), and both halves come off that same row — so taking them together
 * removes the class of bug where one is passed and the other forgotten, which
 * would resolve a backend and then authenticate it with nothing.
 */
export function runtimeContextOf(
  row: { backendsConfig?: unknown; modelProviders?: unknown } | null | undefined,
): RuntimeContext {
  return { backends: backendsConfigOf(row), credentials: modelCredentialsOf(row) };
}

/**
 * Mode when neither level names one. Only ever applied to pi sessions — see
 * the null for every other harness in resolveRuntime.
 */
export const DEFAULT_PI_MODE = 'omp';

const FLOOR: Backend = BUILT_IN_BACKENDS[0];

/**
 * The backend a stored id names, as this machine can run it.
 *
 * `substitutable` is the difference between the two levels. An agent's default
 * is a preference and gets re-pointed when the machine cannot run it. A
 * session's OWN choice never is: switching a backend off hides it from new work,
 * it does not stop what is already running on it, and reporting a running
 * claude session as codex would make every header chip a lie.
 */
function resolveLevel(
  ctx: RuntimeContext,
  stored: string | null | undefined,
  substitutable: boolean,
): { backend: Backend; substituted: boolean } {
  if (!stored) return { backend: FLOOR, substituted: false };
  if (substitutable) {
    const id = effectiveDefaultBackendId(stored, ctx.backends);
    const backend = listBackends(ctx.backends).find((b) => b.id === id) ?? FLOOR;
    // Substituted when the stored id did not survive — either it named a
    // backend this machine has switched off or deleted, or it was a legacy
    // bare-harness value that mapped onto an instance with a different id.
    return { backend, substituted: backend.id !== stored };
  }
  const exact = backendById(ctx.backends, stored);
  if (exact) return { backend: exact, substituted: exact.id !== stored };
  // Nothing on this machine defines this id any more — a deleted instance, or a
  // legacy bare harness with no backend built on it. Falling to the floor is the
  // only answer that can actually take a turn: the harness might still be
  // installed, but its credential is gone, so spawning it would 401 at the first
  // message with nothing on screen to explain why.
  return { backend: FLOOR, substituted: true };
}

/**
 * session's own choice > agent's default (as this machine can run it) > the floor.
 *
 * provider/model follow the level that actually chose the backend. A session
 * that switches to a different backend than its agent must NOT inherit the
 * agent's pins — those describe a different backend and would be nonsense (or,
 * worse, silently point pi at a claude model name). When both levels agree, the
 * session may leave them unset and inherit, which is the common "same backend,
 * default model" case.
 *
 * Below both pins sits the backend's own default model, and below that the
 * credential's. That is what makes a custom backend usable with nothing pinned
 * anywhere: "pi + hyqubit" already knows which model it means.
 */
export function resolveRuntime(
  session: Level,
  agent: Level,
  ctx?: RuntimeContext | null,
): RuntimeChoice {
  const c: RuntimeContext = ctx ?? { backends: null, credentials: [] };

  const agentLevel = resolveLevel(c, agent?.runtime ?? DEFAULT_RUNTIME, true);
  const chosen = session?.runtime
    ? resolveLevel(c, session.runtime, false)
    : agentLevel;
  const backend = chosen.backend;

  // Whether the agent's pins describe the backend we resolved to. A substituted
  // agent default lands on a different backend than its columns were written
  // for, so it inherits nothing from them — same rule as a session that picks
  // its own backend, for the same reason.
  const inheritable = session?.runtime
    ? backend.id === agentLevel.backend.id && !agentLevel.substituted
    : !agentLevel.substituted;

  const credential = credentialById(c.credentials, backend.credentialId);

  const pinnedModel = session?.runtimeModel ?? (inheritable ? agent?.runtimeModel ?? null : null);
  const pinnedProvider = session?.runtimeProvider ?? (inheritable ? agent?.runtimeProvider ?? null : null);

  const isPi = backend.harness === 'pi-rpc';
  const pinnedMode = session?.runtimeMode ?? (inheritable ? agent?.runtimeMode ?? null : null);

  return {
    backendId: backend.id,
    runtime: backend.harness,
    runtimeCredentialId: backend.credentialId,
    // The credential names the provider; a stored pin still wins so a session
    // configured before credentials existed keeps running as it was.
    runtimeProvider: pinnedProvider ?? credential?.provider ?? null,
    runtimeModel: pinnedModel ?? backend.model ?? defaultModelOf(credential),
    // A mode is a pi spawn recipe (system prompt, tool allowlist, skills,
    // extensions) and no other harness can honour one, so resolving it to null
    // here means it cannot be misread downstream.
    runtimeMode: isPi ? pinnedMode ?? backend.mode ?? DEFAULT_PI_MODE : null,
  };
}
