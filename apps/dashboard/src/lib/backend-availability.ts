// Which backends this machine offers — Settings → Backends.
//
// Stored on Machine.backendsConfig as the DISABLED set rather than the enabled
// one. "Nothing configured" then means "everything this build knows about",
// which is the behaviour every existing machine already had, and a backend
// added in a later release appears instead of being invisible until someone
// finds a toggle nobody told them about.
//
// Pure functions with their own tests, because the rules that matter here are
// the awkward ones — never offer an empty picker, and never hide the option a
// session is already running on.

import { BACKEND_OPTIONS, type BackendOption } from './runtime-labels';

export type BackendsConfig = { disabled: string[] };

/** The default a machine that has never been configured behaves as. */
export const ALL_ENABLED: BackendsConfig = { disabled: [] };

export function isBackendEnabled(
  option: BackendOption,
  config: BackendsConfig | null | undefined,
): boolean {
  return !(config?.disabled ?? []).includes(option);
}

/**
 * The cards a picker should show.
 *
 * `current` is always included even when disabled: the picker has to be able to
 * represent the state the session is actually in. Hiding it would silently
 * redraw the selection as something else — the user would open the sheet on a
 * codex session and see "Claude Code" selected, which is a lie about what is
 * running.
 *
 * Never returns an empty list. A machine with everything switched off would
 * otherwise render a picker with no options and no way back; claude-tmux is the
 * floor because it is the one backend that needs no per-machine setup.
 */
export function availableBackends(
  config: BackendsConfig | null | undefined,
  current?: BackendOption | null,
): BackendOption[] {
  const list = BACKEND_OPTIONS.filter(
    (o) => isBackendEnabled(o, config) || o === current,
  );
  if (list.length > 0) return list;
  return current ? [current] : ['claude-tmux'];
}

/**
 * Apply a toggle, refusing the one that leaves nothing.
 *
 * Returns null when the change is not allowed, so the caller can say why rather
 * than silently keeping the old state — a toggle that springs back with no
 * explanation reads as a bug.
 */
export function toggleBackend(
  config: BackendsConfig | null | undefined,
  option: BackendOption,
  enabled: boolean,
): BackendsConfig | null {
  const disabled = new Set(config?.disabled ?? []);
  if (enabled) disabled.delete(option);
  else disabled.add(option);

  const left = BACKEND_OPTIONS.filter((o) => !disabled.has(o));
  if (left.length === 0) return null;
  // Ordered by BACKEND_OPTIONS rather than insertion, so the stored value does
  // not churn between equivalent sets and produce pointless writes.
  return { disabled: BACKEND_OPTIONS.filter((o) => disabled.has(o)) };
}
