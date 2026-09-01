// The contract between chat-runner and an agent backend.
//
// A runtime owns a live session and reports what the conversation produced.
// It never decides how that is persisted — `emit` hands items to chat-runner's
// existing sync coalescing, which exists because a gateway restart otherwise
// re-POSTs every transcript one request at a time and saturates the dashboard.
//
// See docs/pi-runtime-design.md.

/** One outbound chat-message sync — the shape /api/sync/chat-message accepts. */
export type SyncItem = {
  sessionId: string;
  role: string;
  content: unknown;
  externalId: string;
  claudeSessionId: string | null;
  /**
   * Retract the row this externalId names instead of writing it.
   *
   * A turn streams into a placeholder row and retracts it in the same batch that
   * writes the finished message, so the growing bubble BECOMES the real one in a
   * single push. Without the retraction the placeholder would have to be keyed
   * the same as the finished row — and the only id available while a block is
   * still arriving is one we invent, which the JSONL backstop would not
   * recognise and would therefore duplicate on the next attach.
   */
  deleted?: boolean;
  /**
   * A preview, not an arrival.
   *
   * The dashboard writes the row and wakes the open chat stream, but does not
   * treat it as a new message: no unread mark, and no push notification. A
   * phone should buzz once, when the reply is finished — not at whatever the
   * first twenty characters happened to be.
   */
  transient?: boolean;
};

export type RuntimeKind =
  | 'claude-tmux' | 'claude-sdk'
  | 'pi-rpc' | 'omp-rpc' | 'prime-rpc'
  | 'codex-exec' | 'dsh-exec' | 'kimi-code';

export type RuntimeSession = {
  id: string;
  agentName: string;
  agentDirectory: string;
  /** The backend's own session id, if we have resumed one before. */
  externalSessionId: string | null;
  provider?: string | null;
  model?: string | null;
  /**
   * Which Settings → Models credential authenticates this session's harness.
   *
   * Already resolved by the dashboard: a backend is a harness paired with a
   * credential, and the pairing is a machine-level setting the gateway has no
   * business re-deriving. Null for the two subscription backends, which
   * authenticate as themselves — and for a session from a dashboard that has
   * not been upgraded yet, which falls back to the machine's first credential.
   */
  credentialId?: string | null;
  /**
   * Which pi mode to spawn under (already resolved by the dashboard against the
   * agent's default). null for the backends with no such concept — claude-tmux,
   * codex-exec and dsh-exec.
   */
  mode?: string | null;
  /**
   * May this session hold the hermit tool surface and the machine key that
   * authenticates it? Defaults to true — every CHAT session wants them.
   *
   * A cron fire sets it false, and the reason is not caution in the abstract:
   * the hermit tools (set_session_title, log_status, attach_image, attach_file,
   * ask) all act on HERMIT_SESSION_ID, and a cron's session id is a throwaway
   * that has no ChatSession row behind it. So on a cron they cannot succeed —
   * every call 404s server-side — while the machine's dashboard credential sits
   * in the child's environment and in every tool subprocess it spawns. Useless
   * and exposed at once. The pane path has refused this since crons existed
   * (cron-runner.ts → cronPaneEnv, pinned by a test); this is what lets a cron
   * keep that refusal after moving off the pane.
   *
   * Honoured by claude-sdk, pi-rpc, omp-rpc and prime-rpc — the four that give a
   * child the hermit tool surface. codex-exec does not honour it yet (it has
   * always had this, since codex crons predate the flag). dsh-exec needs no
   * flag: it has no hermit tool surface and never receives the key.
   */
  hermitTools?: boolean;
  /**
   * The orchestrator ("义脑") session, which gets the brain-only cross-agent MCP
   * tools. Only the backends that run a real Claude Code session read it; the
   * others have no equivalent tool surface to widen.
   */
  isOrchestrator?: boolean;
  /**
   * Pure-chat session: spawn the child with a READ-ONLY tool surface — it may
   * look at files and search the web, but not write, edit, run commands or
   * spawn sub-agents. Defaults to false; only a session the user ticked the box
   * for passes true.
   *
   * Unlike hermitTools this is NOT one mechanism. No backend's write tools are
   * forwarded by us — bash / write / edit / apply_patch / ipython all ship
   * inside the CLI — so each runtime honours this with its own switch:
   * claude-sdk and claude-tmux narrow `tools`, codex drops to its read-only OS
   * sandbox, pi and omp narrow `--tools`, dsh disables its write plugins, kimi
   * gets deny rules in its config. prime cannot honour it usefully (one tool,
   * `ipython`, is its entire surface) and loses that tool outright.
   *
   * It is a SPAWN-TIME property: flipping it on a live session does nothing
   * until the child respawns.
   */
  chatOnly?: boolean;
};

export type RuntimeImage = { path: string; mediaType: string };

export type RuntimeUsage = {
  /**
   * Context occupancy of the latest model call, not a runtime turn or session
   * total. One agentic runtime turn may contain many model calls around tools;
   * summing those calls measures spend, not how full the window is.
   *
   * This exists to mean the same thing as the claude path's `contextTokens`,
   * which is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
   * off the most recent assistant message — i.e. "how full is the window right
   * now". A cumulative session total would climb forever and render as a
   * context bar that only ever fills up.
   */
  contextTokens: number | null;
  /** Output tokens of the latest model call, same basis as contextTokens. */
  outputTokens: number | null;
  /** Cumulative for the whole session — cost reporting, not the context bar. */
  totalTokens: number;
  costUsd: number | null;
};

export interface RuntimeHandle {
  readonly sessionId: string;
  readonly externalSessionId: string;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;

  /**
   * Does `submit` take image attachments as-is?
   *
   * Most backends cannot: the chat runner recognises each attachment with a
   * vision pass first and hands over the DESCRIPTION as text. A backend that
   * speaks Anthropic content blocks wants the opposite — the bytes, in the
   * first request, with no round-trip and no lossy prose in between. Declaring
   * it here keeps that decision with the backend that knows the answer rather
   * than as a `kind ===` test in the runner.
   */
  readonly acceptsImages?: boolean;

  /**
   * Start or re-attach the session. Idempotent.
   *
   * Implementations must dedupe on `externalId` before emitting: both backends
   * replay. The tmux path re-reads the transcript from line 1 after a gateway
   * restart; the pi path re-reads durable session entries after a reconnect.
   */
  ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle>;

  /** Deliver a user turn. Returns false if it could not be submitted. */
  submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean>;

  /** Is a turn currently in flight? Gates the message queue. */
  isWorking(handle: RuntimeHandle): Promise<boolean>;

  /**
   * Is this backend still holding the session — a live child, an open
   * connection, anything that would still be writing to its transcript?
   *
   * NOT `isWorking`: a session can be held and idle, and that is precisely the
   * state the destructive paths must not mistake for "gone". NOT `usage() !==
   * null` either, which is what a caller would otherwise reach for: several
   * backends return null usage for a live session that has not taken a turn yet
   * (codex until a rollout exists, dsh until totals do), so a purge gated on it
   * would unlink the transcript of a session that is running.
   *
   * Required rather than optional, because the callers are the ones that delete
   * things. A backend that could decline to answer would be assumed dead, and
   * the assumption would be invisible until it destroyed something — the same
   * silent-degradation shape as a pane check on a session that has no pane.
   */
  isLive(handle: RuntimeHandle): Promise<boolean>;

  interrupt(handle: RuntimeHandle): Promise<void>;
  compact(handle: RuntimeHandle, instructions?: string): Promise<void>;

  /** Token/cost for the collectors. */
  usage(handle: RuntimeHandle): Promise<RuntimeUsage | null>;

  /**
   * What the session is doing right now, beyond "working or not".
   *
   * Optional because most backends cannot say: a pane offers a scraped spinner,
   * and the one-subprocess-per-turn backends know only that a child is alive. A
   * backend with a typed event stream can name the tool, its elapsed time, the
   * subagent, or the API retry it is waiting on — which is the difference
   * between a session that LOOKS hung and one that says why it is slow.
   */
  activity?(handle: RuntimeHandle): Promise<unknown | null>;

  /**
   * Optional durable usage when no live handle exists (for example, a Codex
   * rollout after a gateway restart). Collectors may use this to repair token
   * fields, but it does not make the session alive or wake a hibernated one.
   */
  storedUsage?(handle: RuntimeHandle, transcriptPath?: string | null): Promise<RuntimeUsage | null>;

  /** Stop the session; `hibernate` keeps durable state for later resume. */
  stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void>;
}
