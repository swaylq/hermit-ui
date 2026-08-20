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
};

export type RuntimeKind =
  | 'claude-tmux' | 'claude-sdk'
  | 'pi-rpc' | 'omp-rpc' | 'prime-rpc'
  | 'codex-exec' | 'dsh-exec';

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
   * The orchestrator ("义脑") session, which gets the brain-only cross-agent MCP
   * tools. Only the backends that run a real Claude Code session read it; the
   * others have no equivalent tool surface to widen.
   */
  isOrchestrator?: boolean;
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

  interrupt(handle: RuntimeHandle): Promise<void>;
  compact(handle: RuntimeHandle, instructions?: string): Promise<void>;

  /** Token/cost for the collectors. */
  usage(handle: RuntimeHandle): Promise<RuntimeUsage | null>;

  /**
   * Optional durable usage when no live handle exists (for example, a Codex
   * rollout after a gateway restart). Collectors may use this to repair token
   * fields, but it does not make the session alive or wake a hibernated one.
   */
  storedUsage?(handle: RuntimeHandle): Promise<RuntimeUsage | null>;

  /** Stop the session; `hibernate` keeps durable state for later resume. */
  stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void>;
}
