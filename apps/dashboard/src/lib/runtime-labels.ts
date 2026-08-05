// How a backend is named in the UI.
//
// Three places render the same choice — the chat header chip, the session
// detail sheet and the new-chat picker — and they were drifting apart (the
// header said "Claude", the picker "Claude Code"). One table, no ternaries.
//
// See docs/pi-runtime-design.md.

export const RUNTIME_KINDS = ['claude-tmux', 'pi-rpc'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return v === 'claude-tmux' || v === 'pi-rpc';
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
  'pi-rpc': 'pi as an RPC child process. Any provider, no MCP, no terminal pane.',
};
