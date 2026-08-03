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

export type RuntimeKind = 'claude-tmux' | 'pi-rpc';

export type RuntimeSession = {
  id: string;
  agentName: string;
  agentDirectory: string;
  /** The backend's own session id, if we have resumed one before. */
  externalSessionId: string | null;
  provider?: string | null;
  model?: string | null;
};

export type RuntimeImage = { path: string; mediaType: string };

export type RuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
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
