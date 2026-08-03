import type { AgentRuntime } from './types';
import { PiRpcRuntime } from './pi-rpc';

const piRuntime = new PiRpcRuntime();

/**
 * Pick the backend for a session.
 *
 * Only 'pi-rpc' is served here. 'claude-tmux' (and anything unrecognised)
 * returns null so the caller keeps its existing inline tmux path, which this
 * change deliberately does not touch — that path is the fleet's critical path
 * and the only one that bills against Claude Max's Interactive bucket.
 */
export function runtimeFor(kind: string | null | undefined): AgentRuntime | null {
  return kind === 'pi-rpc' ? piRuntime : null;
}

export type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
