// The HARNESS vocabulary — what a runtime kind is called, and what it is.
//
// A harness is the framework that runs a turn. It is not the same thing as a
// backend: a backend is a harness paired with a credential, and the user
// creates those under Settings → Backends. See lib/backends.ts for that layer,
// and docs/backends-and-models-design.md for why the two are separate.
//
// Three places render a harness name — the chat header chip, the session detail
// sheet and the new-chat picker — and they were drifting apart (the header said
// "Claude", the picker "Claude Code"). One table, no ternaries.

// Six harnesses. omp (oh-my-pi) is NOT one of them: it is a second ENGINE
// inside the pi harness, selected by the mode — see lib/pi-modes.ts.
//
// claude-sdk, claude-tmux and codex-exec are the three that authenticate as
// themselves, on the machine, against a subscription. The other three take a
// credential from Settings → Models, which is what makes them user-composable.
//
// The two claude harnesses are the SAME Claude Code, reached two ways:
// 'claude-sdk' through its official Agent SDK, 'claude-tmux' by typing into its
// terminal UI in a pane. The pane exists only because the SDK was once billed
// separately — a split that was paused before it took effect (evolution/
// lessons.md → L1) — and is kept for the one thing it still does better:
// outliving the gateway process. See docs/claude-sdk-runtime-design.md.
export const RUNTIME_KINDS = ['claude-sdk', 'claude-tmux', 'pi-rpc', 'prime-rpc', 'codex-exec', 'dsh-exec'] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return RUNTIME_KINDS.includes(v as RuntimeKind);
}

/**
 * The harnesses a user can build a backend out of.
 *
 * The other three are excluded because there is nothing to compose: both Claude
 * Code drivers and Codex each have exactly one credential — their own
 * subscription on this machine — so a picker offering "Claude Code + hyqubit"
 * would be offering something that does not exist.
 */
export const CUSTOM_HARNESSES = ['pi-rpc', 'prime-rpc', 'dsh-exec'] as const;
export type CustomHarness = (typeof CUSTOM_HARNESSES)[number];

// `unknown` rather than `string | null | undefined`: the caller that matters
// most is reading a value straight off a JSON column, where nothing has
// promised it is a string at all.
export function isCustomHarness(v: unknown): v is CustomHarness {
  return typeof v === 'string' && CUSTOM_HARNESSES.includes(v as CustomHarness);
}

/** Full name of a harness, for pickers and headings. */
export function runtimeLabel(kind: string | null | undefined): string {
  if (kind === 'claude-tmux') return 'Claude Code (tmux)';
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'prime-rpc') return 'Prime Agent';
  if (kind === 'codex-exec') return 'Codex';
  if (kind === 'dsh-exec') return 'DeepSeek';
  return 'Claude Code';
}

/** Short name for the chat header, where the meta line is tight at 390px. */
export function runtimeShortLabel(kind: string | null | undefined): string {
  if (kind === 'pi-rpc') return 'pi';
  if (kind === 'prime-rpc') return 'prime';
  if (kind === 'codex-exec') return 'Codex';
  if (kind === 'dsh-exec') return 'dsh';
  return 'Claude';
}

/** One line of hover detail: the harness plus whatever qualifies it. */
export function runtimeDetail(
  kind: string | null | undefined,
  provider?: string | null,
  model?: string | null,
): string {
  // No provider for codex: it authenticates as itself (`codex login`) and has
  // no endpoint to name, so naming one would be a field the user cannot set and
  // the harness does not read.
  if (kind === 'codex-exec') return ['Codex', model].filter(Boolean).join(' · ');
  if (kind === 'claude-sdk') return ['Claude Code (Agent SDK)', model].filter(Boolean).join(' · ');
  if (kind === 'claude-tmux') return 'Claude Code (interactive, tmux pane)';
  return [runtimeLabel(kind), provider, model].filter(Boolean).join(' · ');
}

/** What each harness actually is — shown under the picker so a choice is informed. */
export const RUNTIME_BLURB: Record<RuntimeKind, string> = {
  'claude-sdk': 'Claude Code via its official Agent SDK, on this machine’s subscription. Same tools and skills; typed events, no pane.',
  'claude-tmux': 'The same Claude Code, driven through a tmux pane. Attachable terminal, and it survives a gateway restart.',
  'pi-rpc': 'pi or omp as an RPC child process. Small and predictable; pick the engine and recipe under Mode.',
  'prime-rpc': 'Prime Agent. One tool — a persistent IPython kernel — plus subagents and a self-refining harness.',
  'codex-exec': 'OpenAI Codex, one run per turn, on this machine’s own codex login.',
  'dsh-exec': 'DeepSeek Harness (dsh), one run per turn, resumed by session id.',
};

/** What a harness needs on the machine before a backend built on it will start. */
export const RUNTIME_NEEDS: Record<RuntimeKind, string> = {
  'claude-sdk': 'Claude Code installed and logged in. Nothing else to configure.',
  'claude-tmux': 'Claude Code installed and logged in, plus tmux. Nothing else to configure.',
  'pi-rpc': 'pi (bundled) or omp (`bun install -g @oh-my-pi/pi-coding-agent`) on this machine.',
  'prime-rpc': 'Prime Agent installed (`curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh`) plus its Python kernel.',
  'codex-exec': '`codex` installed and `codex login` completed as the gateway’s user.',
  'dsh-exec': 'DeepSeek Harness (dsh) installed on this machine.',
};

/**
 * Is there a tmux pane behind a session on this harness?
 *
 * The mirror of the gateway's `runtimeFor()`: every harness it hands a session
 * to runs as a child process, and what is left over — claude-tmux — is the one
 * that lives in a pane. Listed as the paneless set rather than
 * `=== 'claude-tmux'` so an unrecognised value keeps the pane answer, which is
 * the fallback the gateway itself makes.
 *
 * A predicate rather than an inline comparison because getting it wrong is
 * invisible until someone clicks: the chat header's terminal link once tested
 * `!== 'pi-rpc'`, so codex — added later, and just as paneless — kept a terminal
 * button that attached to a pane that does not exist (`tmux attach` exits 1 and
 * the xterm dies on open).
 */
const PANELESS_RUNTIMES: ReadonlySet<string> = new Set([
  // Claude Code through the Agent SDK: a gateway subprocess on pipes, with no
  // terminal to attach to. Its transcript is identical to the pane's.
  'claude-sdk',
  'pi-rpc',
  'prime-rpc',
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

/**
 * Harnesses that share one conversation store.
 *
 * The two Claude Code drivers spawn the same binary against the same session
 * uuid and append to the same `~/.claude/projects/<cwd>/<uuid>.jsonl`. So moving
 * a session between them carries the RUNNING CONTEXT, not just the message list
 * the dashboard keeps — the new driver resumes the transcript the old one wrote.
 *
 * Verified end-to-end in production: a session told a number on claude-tmux,
 * switched to claude-sdk, recalled it on the next turn.
 *
 * Every other pair holds session ids that are meaningless (pi, prime) or fatal
 * (codex's `thread/resume: no rollout found`) to the other side, so for those
 * the context genuinely is dropped.
 */
const SAME_CONVERSATION: ReadonlySet<string> = new Set(['claude-tmux', 'claude-sdk']);

export function sharesConversation(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return SAME_CONVERSATION.has(before ?? '') && SAME_CONVERSATION.has(after ?? '');
}
