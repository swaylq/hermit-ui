// How a backend is named in the UI.
//
// Three places render the same choice — the chat header chip, the session
// detail sheet and the new-chat picker — and they were drifting apart (the
// header said "Claude", the picker "Claude Code"). One table, no ternaries.
//
// See docs/pi-runtime-design.md.

// Two backends, not three. omp (oh-my-pi) is a second ENGINE inside the pi
// backend, selected by the mode — see lib/pi-modes.ts. Which engine runs and
// which recipe it runs are one decision from the user's side, and keeping them
// one also keeps a single auth configuration serving both.
export const RUNTIME_KINDS = ['claude-tmux', 'pi-rpc'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return RUNTIME_KINDS.includes(v as RuntimeKind);
}

/** Full name, for pickers and headings. */
export function runtimeLabel(kind: string | null | undefined): string {
  return kind === 'pi-rpc' ? 'pi' : 'Claude Code';
}

/** Short name for the chat header, where the meta line is tight at 390px. */
export function runtimeShortLabel(kind: string | null | undefined): string {
  return kind === 'pi-rpc' ? 'pi' : 'Claude';
}

/** One line of hover detail: the backend plus whatever qualifies it. */
export function runtimeDetail(
  kind: string | null | undefined,
  provider?: string | null,
  model?: string | null,
): string {
  if (kind !== 'pi-rpc') return 'Claude Code (interactive, tmux pane)';
  return ['pi', provider, model].filter(Boolean).join(' · ');
}

/** What each backend actually is — shown under the picker so the choice is informed. */
export const RUNTIME_BLURB: Record<RuntimeKind, string> = {
  'claude-tmux': 'Claude Code in a tmux pane. Slash commands, subagents, terminal access.',
  'pi-rpc': 'pi or omp as an RPC child process. Pick the engine and recipe under Mode.',
};

// ── the picker's own vocabulary ─────────────────────────────────────────────
//
// The card list is NOT the same set as RUNTIME_KINDS, and that is deliberate.
// `triage` is not a third backend: it is an ordinary pi session whose MODE
// decides, on its first turn, which harness it becomes. Nothing downstream
// knows about it — runtimeFor() sees pi-rpc, resolveMode() finds triage on
// disk, buildModeArgs() expands it like any other mode.
//
// It gets a card rather than a row in the Mode dropdown because from the user's
// side the question this picker asks is "who runs this", and the honest answer
// for triage is "it decides" — which is a peer of "Claude" and "pi", not a
// variant of one. Picking it also has to hide the Mode select, since choosing a
// mode by hand is exactly what it exists to avoid.

/** The mode value that means "the harness picks itself". */
export const TRIAGE_MODE = 'triage';

export const BACKEND_OPTIONS = ['claude-tmux', 'pi-rpc', TRIAGE_MODE] as const;
export type BackendOption = (typeof BACKEND_OPTIONS)[number];

export function backendLabel(v: BackendOption): string {
  return v === TRIAGE_MODE ? 'Triage' : runtimeLabel(v);
}

export const BACKEND_BLURB: Record<BackendOption, string> = {
  'claude-tmux': RUNTIME_BLURB['claude-tmux'],
  'pi-rpc': RUNTIME_BLURB['pi-rpc'],
  [TRIAGE_MODE]: 'A pi session that reads the task and becomes the leanest harness that can finish it.',
};

/** The stored columns → which card is selected. */
export function toBackendOption(
  runtime: string | null | undefined,
  runtimeMode: string | null | undefined,
): BackendOption {
  if (runtime === 'pi-rpc' && runtimeMode === TRIAGE_MODE) return TRIAGE_MODE;
  return isRuntimeKind(runtime) ? runtime : 'claude-tmux';
}

/**
 * Which card is selected → what to store.
 *
 * `runtimeMode: null` for the two real backends means "this card says nothing
 * about the mode" — the caller keeps whatever the Mode select holds. Only
 * triage pins one, because for triage the mode IS the choice.
 */
export function fromBackendOption(v: BackendOption): { runtime: RuntimeKind; runtimeMode: string | null } {
  return v === TRIAGE_MODE
    ? { runtime: 'pi-rpc', runtimeMode: TRIAGE_MODE }
    : { runtime: v, runtimeMode: null };
}
