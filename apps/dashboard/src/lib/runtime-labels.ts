// How a backend is named in the UI.
//
// Three places render the same choice — the chat header chip, the session
// detail sheet and the new-chat picker — and they were drifting apart (the
// header said "Claude", the picker "Claude Code"). One table, no ternaries.
//
// See docs/pi-runtime-design.md.

export const RUNTIME_KINDS = ['claude-tmux', 'pi-rpc', 'omp-rpc'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return RUNTIME_KINDS.includes(v as RuntimeKind);
}

/** Does this backend run as a child process with a pi-style mode recipe? */
export function isModeBackend(v: string | null | undefined): boolean {
  return v === 'pi-rpc' || v === 'omp-rpc';
}

/** Full name, for pickers and headings. */
export function runtimeLabel(kind: string | null | undefined): string {
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'omp-rpc') return 'omp';
  return 'Claude Code';
}

/** Short name for the chat header, where the meta line is tight at 390px. */
export function runtimeShortLabel(kind: string | null | undefined): string {
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'omp-rpc') return 'omp';
  return 'Claude';
}

/** One line of hover detail: the backend plus whatever qualifies it. */
export function runtimeDetail(
  kind: string | null | undefined,
  provider?: string | null,
  model?: string | null,
): string {
  if (!isModeBackend(kind)) return 'Claude Code (interactive, tmux pane)';
  return [runtimeLabel(kind), provider, model].filter(Boolean).join(' · ');
}

/** What each backend actually is — shown under the picker so the choice is informed. */
export const RUNTIME_BLURB: Record<RuntimeKind, string> = {
  'claude-tmux': 'Claude Code in a tmux pane. Slash commands, subagents, terminal access.',
  'pi-rpc': 'pi as an RPC child process. Four tools, small and predictable, no MCP.',
  'omp-rpc': 'omp (oh-my-pi) as an RPC child. 31 tools incl. LSP, ast-edit, browser, MCP.',
};
