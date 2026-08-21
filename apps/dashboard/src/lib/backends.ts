// What a backend IS — Settings → Backends.
//
// A backend is what you pick when you start a chat or set an agent's default.
// There are two kinds and the difference is where the credential comes from:
//
//   BUILT-IN   Claude Code and Codex. Each authenticates as itself, on the
//              machine, against its own subscription. Nothing to configure and
//              nothing to choose — which is exactly why they are the two that
//              ship enabled. You can switch them off; you cannot edit them.
//
//   CUSTOM     A harness the user paired with a credential from Settings →
//              Models: pi + hyqubit, prime + Kimi, dsh + OpenRouter. The user
//              creates these, and until they do, the machine offers only the
//              two built-ins.
//
// Deliberately absent: any way to point pi, prime or dsh at the Claude Code
// subscription. The mechanism exists in all three harnesses and it worked, but
// running third-party harnesses against one Max account is the thing rate
// limits and the request classifier exist to catch, and the fleet has decided
// the risk is not worth it. There is no toggle to bring it back — the code path
// is gone from the gateway too (see apps/gateway/src/pi-credentials.ts).
//
// Replaces lib/backend-availability.ts. See docs/backends-and-models-design.md.

import {
  RUNTIME_BLURB, RUNTIME_NEEDS,
  isCustomHarness, type CustomHarness, type RuntimeKind,
} from './runtime-labels';

/**
 * Where an unpinned dsh session got its model before dsh took a credential like
 * every other custom harness.
 *
 * Read once, by the migration, which turns it into a dsh backend on the right
 * credential. Nothing writes it any more; it survives on the type and in
 * backendsConfigOf only so a round-trip through the settings page does not drop
 * it from a machine that has not been migrated yet.
 */
export type DshSource = 'deepseek' | 'pi-endpoint';

/** A backend the user composed: one harness, one credential. */
export type BackendInstance = {
  /** Stable slug, stored on Agent.runtime / ChatSession.runtime. */
  id: string;
  harness: CustomHarness;
  /** → ModelCredential.id in Settings → Models. */
  credentialId: string;
  label: string;
  /** Default model for new sessions; blank falls through to the credential's. */
  model?: string | null;
  /** pi only — the spawn recipe. See lib/pi-modes.ts. */
  mode?: string | null;
};

export type BackendsConfig = {
  /** Backend ids switched off. Stored as the DISABLED set — see backendsConfigOf. */
  disabled: string[];
  instances?: BackendInstance[];
  dshSource?: DshSource;
};

/** What a picker renders, built-in and custom alike. */
export type Backend = {
  id: string;
  harness: RuntimeKind;
  label: string;
  blurb: string;
  builtIn: boolean;
  /** null for the built-ins: their credential is a subscription, not a row. */
  credentialId: string | null;
  model: string | null;
  mode: string | null;
};

/**
 * The floor. Needs no per-machine setup, so it is what an empty config means.
 *
 * Was 'claude-tmux' until the Agent SDK stopped being billed separately
 * (evolution/lessons.md → L1). Same binary and same login either way, so the
 * default should be the driver that does not have to guess at a terminal UI. A
 * session already running on the pane keeps it — this is only what an unstated
 * preference resolves to.
 */
export const DEFAULT_BACKEND_ID = 'claude-sdk';

/**
 * The two that ship enabled.
 *
 * Their ids are the harness kinds they run, unchanged from when a backend and a
 * harness were the same thing. That is not tidiness — every existing Agent and
 * ChatSession row stores one of those strings, and keeping them identical is
 * what lets this whole change land without rewriting a single row.
 */
export const BUILT_IN_BACKENDS: Backend[] = [
  {
    id: 'claude-sdk', harness: 'claude-sdk', label: 'Claude Code',
    blurb: RUNTIME_BLURB['claude-sdk'], builtIn: true,
    credentialId: null, model: null, mode: null,
  },
  {
    // The same Claude Code, driven through a pane. A separate card rather than
    // a hidden setting because it is a real trade-off a user may want to make:
    // an attachable terminal and a session that survives a gateway restart, at
    // the cost of everything in docs/claude-sdk-runtime-design.md.
    id: 'claude-tmux', harness: 'claude-tmux', label: 'Claude Code (tmux)',
    blurb: RUNTIME_BLURB['claude-tmux'], builtIn: true,
    credentialId: null, model: null, mode: null,
  },
  {
    id: 'codex-exec', harness: 'codex-exec', label: 'Codex',
    blurb: RUNTIME_BLURB['codex-exec'], builtIn: true,
    credentialId: null, model: null, mode: null,
  },
];

const BUILT_IN_IDS: ReadonlySet<string> = new Set(BUILT_IN_BACKENDS.map((b) => b.id));

export function isBuiltInBackendId(id: string | null | undefined): boolean {
  return BUILT_IN_IDS.has(id ?? '');
}

/** The default a machine that has never been configured behaves as. */
export const ALL_ENABLED: BackendsConfig = { disabled: [] };

/**
 * Read the config off a Machine row's JSON column.
 *
 * Prisma types it as unknown-ish JSON and nothing validates what an older
 * release wrote, so this tolerates any shape. Unlike its predecessor it returns
 * a config rather than null for an unreadable value: instances are the only
 * place custom backends exist, and silently reporting "none" for a machine that
 * has three would make every one of its sessions fall back to claude-tmux.
 */
export function backendsConfigOf(
  row: { backendsConfig?: unknown } | null | undefined,
): BackendsConfig | null {
  const raw = row?.backendsConfig;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const disabled = Array.isArray(r.disabled)
    ? r.disabled.filter((d): d is string => typeof d === 'string')
    : [];
  const instances = Array.isArray(r.instances) ? readInstances(r.instances) : [];
  const source = r.dshSource;
  return {
    disabled,
    ...(instances.length ? { instances } : {}),
    // Whitelisted, not passed through: an older release reading a value a newer
    // one wrote must land on the default, never on an unknown string.
    ...(source === 'deepseek' || source === 'pi-endpoint' ? { dshSource: source } : {}),
  };
}

function readInstances(raw: unknown[]): BackendInstance[] {
  const out: BackendInstance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const i = item as Record<string, unknown>;
    if (typeof i.id !== 'string' || !i.id || BUILT_IN_IDS.has(i.id)) continue;
    if (!isCustomHarness(i.harness)) continue;
    if (typeof i.credentialId !== 'string' || !i.credentialId) continue;
    out.push({
      id: i.id,
      harness: i.harness,
      credentialId: i.credentialId,
      label: typeof i.label === 'string' && i.label ? i.label : i.id,
      ...(typeof i.model === 'string' ? { model: i.model } : {}),
      ...(typeof i.mode === 'string' ? { mode: i.mode } : {}),
    });
  }
  return out;
}

export function instancesOf(config: BackendsConfig | null | undefined): BackendInstance[] {
  return config?.instances ?? [];
}

/** A custom instance rendered as a Backend. */
export function instanceAsBackend(i: BackendInstance): Backend {
  return {
    id: i.id,
    harness: i.harness,
    label: i.label,
    blurb: RUNTIME_BLURB[i.harness],
    builtIn: false,
    credentialId: i.credentialId,
    model: i.model ?? null,
    mode: i.mode ?? null,
  };
}

/** Every backend this machine knows about, enabled or not. Built-ins first. */
export function listBackends(config: BackendsConfig | null | undefined): Backend[] {
  return [...BUILT_IN_BACKENDS, ...instancesOf(config).map(instanceAsBackend)];
}

export function isBackendEnabled(id: string, config: BackendsConfig | null | undefined): boolean {
  return !(config?.disabled ?? []).includes(id);
}

/**
 * The cards a picker should show.
 *
 * `current` is always included even when disabled or unknown: the picker has to
 * be able to represent the state the session is actually in. Hiding it would
 * silently redraw the selection as something else — the user would open the
 * sheet on a codex session and see "Claude Code" selected, which is a lie about
 * what is running.
 *
 * Never returns an empty list. A machine with everything switched off would
 * otherwise render a picker with no options and no way back; claude-tmux is the
 * floor because it is the one backend that needs no per-machine setup.
 */
export function availableBackends(
  config: BackendsConfig | null | undefined,
  current?: string | null,
): Backend[] {
  const all = listBackends(config);
  const list = all.filter((b) => isBackendEnabled(b.id, config) || b.id === current);
  // A DELETED backend gets no card. It looks like a gap in the "never
  // misrepresent what is running" rule and is not: the resolver has already
  // moved that session to the floor, because a backend whose credential is gone
  // cannot authenticate a turn — so claude-tmux is what the next message really
  // starts on, and the picker showing it is the truthful answer, not a lie.
  if (list.length > 0) return list;
  return [BUILT_IN_BACKENDS[0]];
}

/**
 * A stored value that names a HARNESS rather than a backend.
 *
 * Every Agent and ChatSession row written before this change holds one of
 * these. They are resolved by pointing at the first enabled instance of that
 * harness (see backendById), which is what the migration creates — and if a
 * machine has none, the session degrades to the floor (BUILT_IN_BACKENDS[0],
 * DEFAULT_BACKEND_ID) rather than failing to start, the same one-directional
 * soft failure an unknown pi mode already has.
 */
export function legacyHarnessOf(id: string | null | undefined): CustomHarness | null {
  // The short-lived third backend, folded back into pi as an engine chosen by
  // the mode. Mapped rather than dropped so a session created during that
  // window still resolves to something that runs.
  if (id === 'omp-rpc') return 'pi-rpc';
  return isCustomHarness(id) ? id : null;
}

/**
 * Resolve a stored backend id.
 *
 * Returns null when the id names nothing this machine can run, which the
 * resolver reads as "fall back to the floor".
 */
export function backendById(
  config: BackendsConfig | null | undefined,
  id: string | null | undefined,
): Backend | null {
  if (!id) return null;
  const exact = listBackends(config).find((b) => b.id === id);
  if (exact) return exact;
  const harness = legacyHarnessOf(id);
  if (!harness) return null;
  const inherited = instancesOf(config).find(
    (i) => i.harness === harness && isBackendEnabled(i.id, config),
  );
  return inherited ? instanceAsBackend(inherited) : null;
}

/**
 * The default a machine can actually run.
 *
 * A stored default is a PREFERENCE, not the answer: Settings → Backends can
 * switch it off (or the instance it named can be deleted) afterwards, and then
 * the default points at something the machine no longer offers. That showed up
 * as "Claude Code · default · off" drawn as the selected card on a machine with
 * only codex enabled — an unclickable card, and a New chat that would open on a
 * backend nobody there can run.
 *
 * Nothing is rewritten in the database. Switching it back on restores the
 * agent's own default, which is what makes this safe to apply on every read
 * rather than as a migration.
 */
export function effectiveDefaultBackendId(
  stored: string | null | undefined,
  config: BackendsConfig | null | undefined,
): string {
  const resolved = backendById(config, stored);
  if (resolved && isBackendEnabled(resolved.id, config)) return resolved.id;
  const first = availableBackends(config)[0];
  return first?.id ?? DEFAULT_BACKEND_ID;
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
  id: string,
  enabled: boolean,
): BackendsConfig | null {
  const disabled = new Set(config?.disabled ?? []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  const known = listBackends(config).map((b) => b.id);
  if (known.every((k) => disabled.has(k))) return null;
  // Ordered by the known list rather than by insertion, so the stored value
  // does not churn between equivalent sets and produce pointless writes. Spread
  // first: a toggle must not drop the OTHER settings this config carries.
  return { ...(config ?? { disabled: [] }), disabled: known.filter((k) => disabled.has(k)) };
}

/** An instance id not already taken, built-ins included. */
export function uniqueBackendId(
  harness: CustomHarness,
  credentialId: string,
  config: BackendsConfig | null | undefined,
): string {
  const short = harness.replace(/-(rpc|exec|tmux)$/, '');
  const base = `${short}-${credentialId}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48);
  const taken = new Set<string>([...BUILT_IN_IDS, ...instancesOf(config).map((i) => i.id)]);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 200; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * What the Backends dialog is about to store, from what the form holds.
 *
 * Pulled out of the component because these are the rules that can actually be
 * wrong, and a rendered dialog is a poor place to pin them down:
 *
 *  - a blank name falls back to the suggestion, so the common case is one click;
 *  - a blank model is stored as **null**, not omitted — an omitted key merges as
 *    "leave whatever was there", so clearing the field on an edit would silently
 *    do nothing, which reads as the save not working;
 *  - only pi has modes, and only a mode that differs from the fleet default is
 *    worth storing (see lib/pi-modes).
 */
export function backendPatchFrom(input: {
  harness: CustomHarness;
  credentialId: string;
  label: string;
  suggestedLabel: string;
  model: string;
  mode: string;
  defaultMode: string;
}): Omit<BackendInstance, 'id'> {
  return {
    harness: input.harness,
    credentialId: input.credentialId,
    label: input.label.trim() || input.suggestedLabel,
    model: input.model.trim() || null,
    mode: input.harness === 'pi-rpc' && input.mode !== input.defaultMode ? input.mode : null,
  };
}

export function addBackendInstance(
  config: BackendsConfig | null | undefined,
  instance: BackendInstance,
): BackendsConfig {
  const base = config ?? { disabled: [] };
  return { ...base, instances: [...instancesOf(base), instance] };
}

export function updateBackendInstance(
  config: BackendsConfig | null | undefined,
  id: string,
  patch: Partial<Omit<BackendInstance, 'id'>>,
): BackendsConfig {
  const base = config ?? { disabled: [] };
  return {
    ...base,
    instances: instancesOf(base).map((i) => (i.id === id ? { ...i, ...patch } : i)),
  };
}

/**
 * Remove an instance.
 *
 * Its `disabled` entry goes with it, so re-adding a backend with the same id
 * does not come back switched off — which reads as the delete having failed.
 */
export function removeBackendInstance(
  config: BackendsConfig | null | undefined,
  id: string,
): BackendsConfig {
  const base = config ?? { disabled: [] };
  return {
    ...base,
    disabled: (base.disabled ?? []).filter((d) => d !== id),
    instances: instancesOf(base).filter((i) => i.id !== id),
  };
}

/** What each harness needs installed, for the "add a backend" form. */
export const HARNESS_NEEDS = RUNTIME_NEEDS;
