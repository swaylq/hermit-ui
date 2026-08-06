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

export type RuntimeKind = 'claude-tmux' | 'pi-rpc' | 'omp-rpc';

export type RuntimeSession = {
  id: string;
  agentName: string;
  agentDirectory: string;
  /** The backend's own session id, if we have resumed one before. */
  externalSessionId: string | null;
  provider?: string | null;
  model?: string | null;
  /**
   * Which pi mode to spawn under (already resolved by the dashboard against the
   * agent's default). null for claude-tmux, which has no such concept.
   */
  mode?: string | null;
};

export type RuntimeImage = { path: string; mediaType: string };

export type RuntimeUsage = {
  /**
   * Context occupancy of the LAST turn, not a session total.
   *
   * This exists to mean the same thing as the claude path's `contextTokens`,
   * which is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
   * off the most recent assistant message — i.e. "how full is the window right
   * now". A cumulative session total would climb forever and render as a
   * context bar that only ever fills up.
   */
  contextTokens: number | null;
  /** Output tokens of the last turn, same basis as contextTokens. */
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

  /** Stop the session; `hibernate` keeps durable state for later resume. */
  stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void>;
}
