// How a backend is named in the UI.
//
// Three places render the same choice — the chat header chip, the session
// detail sheet and the new-chat picker — and they were drifting apart (the
// header said "Claude", the picker "Claude Code"). One table, no ternaries.
//
// See docs/pi-runtime-design.md.

// Four backends. omp (oh-my-pi) is NOT one of them: it is a second ENGINE
// inside the pi backend, selected by the mode — see lib/pi-modes.ts. Which
// engine runs and which recipe it runs are one decision from the user's side,
// and keeping them one also keeps a single auth configuration serving both.
//
// codex IS its own backend rather than an engine under something else: it is a
// different vendor on a different subscription, with its own login, its own
// thread store and no mode vocabulary to share.
//
// dsh (DeepSeek Harness) is a backend for the same reason codex is: a different
// vendor's harness with its own session store (~/.dsh/sessions), its own
// credential (DEEPSEEK_API_KEY) and no pi mode vocabulary. One `dsh` run per
// turn, resumed by session id — see docs/dsh-runtime-design.md.
export const RUNTIME_KINDS = ['claude-tmux', 'pi-rpc', 'codex-exec', 'dsh-exec'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return RUNTIME_KINDS.includes(v as RuntimeKind);
}

/** Full name, for pickers and headings. */
export function runtimeLabel(kind: string | null | undefined): string {
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'codex-exec') return 'Codex';
  if (kind === 'dsh-exec') return 'DeepSeek';
  return 'Claude Code';
}

/** Short name for the chat header, where the meta line is tight at 390px. */
export function runtimeShortLabel(kind: string | null | undefined): string {
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'codex-exec') return 'Codex';
  if (kind === 'dsh-exec') return 'dsh';
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
  // dsh reads its provider/model from its own profile config; a session pin
  // overrides the model only, so that is the one qualifier worth naming.
  if (kind === 'dsh-exec') return ['DeepSeek Harness', model].filter(Boolean).join(' · ');
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
  // one `dsh` subprocess per turn, exactly codex's shape — no pane.
  'dsh-exec',
]);

export function hasTmuxPane(runtime: string | null | undefined): boolean {
  return !PANELESS_RUNTIMES.has(runtime ?? '');
}

/** What each backend actually is — shown under the picker so the choice is informed. */
export const RUNTIME_BLURB: Record<RuntimeKind, string> = {
  'claude-tmux': 'Claude Code in a tmux pane. Slash commands, subagents, terminal access.',
  'pi-rpc': 'pi or omp as an RPC child process. Pick the engine and recipe under Mode.',
  'codex-exec': 'OpenAI Codex, one run per turn. Uses this machine’s own codex login.',
  'dsh-exec': 'DeepSeek Harness (dsh), one run per turn. Uses this machine’s DEEPSEEK_API_KEY.',
};

// ── the picker's own vocabulary ─────────────────────────────────────────────
//
// The card list IS RUNTIME_KINDS today. It was not always: `triage` (removed
// 2026-08-15, see docs/pi-harness-design.md) was a card that stored an ordinary
// pi session with its mode pre-decided, which is why the picker speaks in
// BackendOption and maps through to/fromBackendOption rather than using
// RuntimeKind directly. The seam stays: a future card that is not 1:1 with a
// stored runtime lands here without touching the pickers again.

export const BACKEND_OPTIONS = RUNTIME_KINDS;
export type BackendOption = (typeof BACKEND_OPTIONS)[number];

export function backendLabel(v: BackendOption): string {
  return runtimeLabel(v);
}

export const BACKEND_BLURB: Record<BackendOption, string> = RUNTIME_BLURB;

/**
 * The stored columns → which card is selected.
 *
 * `runtimeMode` no longer influences the card (only the retired triage card
 * read it), but every caller holds the pair and the next mode-pinning card
 * would need it back, so the signature keeps both.
 */
export function toBackendOption(
  runtime: string | null | undefined,
  runtimeMode: string | null | undefined,
): BackendOption {
  void runtimeMode;
  return isRuntimeKind(runtime) ? runtime : 'claude-tmux';
}

/**
 * Which card is selected → what to store.
 *
 * `runtimeMode: null` means "this card says nothing about the mode" — the
 * caller keeps whatever the Mode select holds.
 */
export function fromBackendOption(v: BackendOption): { runtime: RuntimeKind; runtimeMode: string | null } {
  return { runtime: v, runtimeMode: null };
}
