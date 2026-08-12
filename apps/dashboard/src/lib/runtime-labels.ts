// How a backend is named in the UI.
//
// Three places render the same choice — the chat header chip, the session
// detail sheet and the new-chat picker — and they were drifting apart (the
// header said "Claude", the picker "Claude Code"). One table, no ternaries.
//
// See docs/pi-runtime-design.md.

// Three backends. omp (oh-my-pi) is NOT one of them: it is a second ENGINE
// inside the pi backend, selected by the mode — see lib/pi-modes.ts. Which
// engine runs and which recipe it runs are one decision from the user's side,
// and keeping them one also keeps a single auth configuration serving both.
//
// codex IS its own backend rather than an engine under something else: it is a
// different vendor on a different subscription, with its own login, its own
// thread store and no mode vocabulary to share.
export const RUNTIME_KINDS = ['claude-tmux', 'pi-rpc', 'codex-exec'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return RUNTIME_KINDS.includes(v as RuntimeKind);
}

/** Full name, for pickers and headings. */
export function runtimeLabel(kind: string | null | undefined): string {
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'codex-exec') return 'Codex';
  return 'Claude Code';
}

/** Short name for the chat header, where the meta line is tight at 390px. */
export function runtimeShortLabel(kind: string | null | undefined): string {
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'codex-exec') return 'Codex';
  return 'Claude';
}

/** One line of hover detail: the backend plus whatever qualifies it. */
export function runtimeDetail(
  kind: string | null | undefined,
  provider?: string | null,
  model?: string | null,
): string {
  // No provider for codex: it authenticates as itself (`codex login`) and has
  // no equivalent of pi's machine-configured endpoint, so naming one would be
  // a field the user cannot set and the backend does not read.
  if (kind === 'codex-exec') return ['Codex', model].filter(Boolean).join(' · ');
  if (kind !== 'pi-rpc') return 'Claude Code (interactive, tmux pane)';
  return ['pi', provider, model].filter(Boolean).join(' · ');
}

/**
 * Is there a tmux pane behind a session on this backend?
 *
 * The mirror of the gateway's `runtimeFor()`: every backend it hands a session
 * to runs as a child process, and what is left over — claude-tmux — is the one
 * that lives in a pane. Listed as the paneless set rather than
 * `=== 'claude-tmux'` so an unrecognised value keeps the pane answer, which is
 * the fallback the gateway itself makes.
 *
 * A predicate rather than an inline comparison because getting it wrong is
 * invisible until someone clicks: the chat header's terminal link tested
 * `!== 'pi-rpc'`, so codex — added later, and just as paneless, one `codex exec`
 * per turn — kept a terminal button that attached to a pane that does not exist
 * (`tmux attach` exits 1 and the xterm dies on open).
 */
const PANELESS_RUNTIMES: ReadonlySet<string> = new Set([
  'pi-rpc',
  // the retired third backend, now an engine under pi — a session row created
  // in that window can still hold it, and it was never a pane either.
  'omp-rpc',
  'codex-exec',
]);

export function hasTmuxPane(runtime: string | null | undefined): boolean {
  return !PANELESS_RUNTIMES.has(runtime ?? '');
}

/** What each backend actually is — shown under the picker so the choice is informed. */
export const RUNTIME_BLURB: Record<RuntimeKind, string> = {
  'claude-tmux': 'Claude Code in a tmux pane. Slash commands, subagents, terminal access.',
  'pi-rpc': 'pi or omp as an RPC child process. Pick the engine and recipe under Mode.',
  'codex-exec': 'OpenAI Codex, one run per turn. Uses this machine’s own codex login.',
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

export const BACKEND_OPTIONS = ['claude-tmux', 'pi-rpc', 'codex-exec', TRIAGE_MODE] as const;
export type BackendOption = (typeof BACKEND_OPTIONS)[number];

export function backendLabel(v: BackendOption): string {
  return v === TRIAGE_MODE ? 'Triage' : runtimeLabel(v);
}

export const BACKEND_BLURB: Record<BackendOption, string> = {
  'claude-tmux': RUNTIME_BLURB['claude-tmux'],
  'pi-rpc': RUNTIME_BLURB['pi-rpc'],
  'codex-exec': RUNTIME_BLURB['codex-exec'],
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
