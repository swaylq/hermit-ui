// pi backend: one `pi --mode rpc` child process per chat session.
//
// pi ships RPC mode explicitly for embedding ("headless operation with JSON
// stdin/stdout protocol"), so unlike the claude path there is no terminal to
// scrape — events arrive typed over LF-framed JSONL.
//
// See docs/pi-runtime-design.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { translatePiEvent } from './pi-events';
import { providerEnv, machineProviderEnv } from './pi-credentials';
import { DASHBOARD_URL, ASST_KEY } from '../config';

// RpcClient's default cliPath search is cwd-relative, so it looks for
// `<agentDir>/dist/cli.js` and dies. The package's `exports` map only defines
// the `import` condition, so require.resolve() cannot see it either — resolve
// through ESM and derive the sibling CLI entry.
//
// Resolved lazily, NOT at module load. chat-runner imports this file for every
// session including claude ones, so a resolution failure at import time would
// crash the gateway and take the whole claude fleet down with it. Failing here
// instead confines the damage to the pi session that asked for it.
let piCliPath: string | null = null;

/** The hermit tools extension, loaded into every pi child with --extension. */
function hermitExtensionPath(): string {
  return fileURLToPath(new URL('./hermit-pi-extension.ts', import.meta.url));
}

function resolvePiCli(): string {
  if (piCliPath) return piCliPath;
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  piCliPath = path.join(path.dirname(entry), 'cli.js');
  return piCliPath;
}

type PiHandle = RuntimeHandle & {
  client: RpcClient;
  /** externalIds already emitted — pi replays durable entries on reconnect. */
  seen: Set<string>;
  ordinal: number;
  /**
   * Usage of the most recent assistant turn.
   *
   * getSessionStats() only reports session totals, but the dashboard's context
   * bar wants current occupancy, so the per-message usage is captured off the
   * event stream as it goes past.
   */
  lastTurn: { contextTokens: number; outputTokens: number } | null;
};

const live = new Map<string, PiHandle>();

// In-flight starts, keyed by session.
//
// ensure() is called from chatTick (~2s) and awaits client.start() between
// checking `live` and populating it. Without this guard several ticks all pass
// the check, each spawns its own pi child and registers its own event listener,
// and every event is emitted once per listener with an independent ordinal —
// which surfaced as the same turn appearing three times in the dashboard.
const starting = new Map<string, Promise<PiHandle>>();

/**
 * Window occupancy for one turn, from pi's per-message Usage.
 *
 * Mirrors the claude path's contextTokens exactly:
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * so the dashboard's context bar means the same thing on both backends.
 */
export function contextTokensFrom(usage: Record<string, unknown> | null | undefined): number | null {
  if (!usage) return null;
  const n = (k: string) => Number(usage[k] ?? 0) || 0;
  return n('input') + n('cacheRead') + n('cacheWrite');
}

function handleOf(handle: RuntimeHandle): PiHandle | null {
  return live.get(handle.sessionId) ?? null;
}

export class PiRpcRuntime implements AgentRuntime {
  readonly kind = 'pi-rpc' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    if (existing) return existing;

    // The child inherits the gateway's env plus the provider key, resolved from
    // the encrypted store at start time so it never lands in a config file.
    const client = new RpcClient({
      cwd: session.agentDirectory,
      cliPath: resolvePiCli(),
      provider: session.provider ?? undefined,
      model: session.model ?? undefined,
      // --extension gives the child hermit's own tools (pi has no MCP), and
      // --no-approve keeps it from trusting project-local extension/skill files
      // it happens to find in the workspace — only ours is loaded on purpose.
      args: ['--extension', hermitExtensionPath()],
      env: {
        ...process.env,
        ...(await providerEnv(session.provider)),
        ...(await machineProviderEnv()),
        HERMIT_DASHBOARD_URL: DASHBOARD_URL,
        HERMIT_KEY: ASST_KEY,
        HERMIT_SESSION_ID: session.id,
      } as Record<string, string>,
    });
    await client.start();

    const state = (await client.getState().catch(() => null)) as { sessionId?: string } | null;

    const handle: PiHandle = {
      sessionId: session.id,
      externalSessionId: state?.sessionId ?? session.externalSessionId ?? '',
      client,
      seen: new Set<string>(),
      ordinal: 0,
      lastTurn: null,
    };
    live.set(session.id, handle);

    client.onEvent((ev: unknown) => {
      const raw = ev as {
        entryId?: string; id?: string; type?: string;
        message?: { role?: string; usage?: Record<string, number> };
      } | null;

      // Same basis as the claude path's contextTokens: what the provider was
      // sent for this turn, cache included.
      if (raw?.type === 'message_end' && raw.message?.role === 'assistant' && raw.message.usage) {
        const u = raw.message.usage;
        handle.lastTurn = {
          contextTokens: contextTokensFrom(u) ?? 0,
          outputTokens: Number(u.output ?? 0),
        };
      }

      // Prefer pi's durable entry id so a reconnect that replays the session
      // dedupes instead of duplicating. Ordinal is only a last resort.
      const key = raw?.entryId ?? raw?.id ?? `ord-${handle.ordinal++}`;
      const externalId = `${session.id}:${key}`;
      if (handle.seen.has(externalId)) return;

      const items = translatePiEvent(ev, externalId);
      if (items.length === 0) return;

      handle.seen.add(externalId);
      for (const item of items) {
        emit({ ...item, sessionId: session.id, claudeSessionId: handle.externalSessionId || null });
      }
    });

    return handle;
  }

  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    const payload = images.map((img) => ({ path: img.path, mediaType: img.mediaType })) as never;
    // steer() lands mid-turn, prompt() starts one — the same distinction the
    // tmux path makes between "queue into a busy pane" and a fresh submit.
    const working = await this.isWorking(handle);
    if (working) await h.client.steer(text, payload);
    else await h.client.prompt(text, payload);
    return true;
  }

  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    const state = (await h.client.getState().catch(() => null)) as
      { isStreaming?: boolean; isCompacting?: boolean } | null;
    if (!state) return false;
    // Compaction is not a model turn but the session cannot accept one either,
    // so for queue-gating purposes it counts as busy.
    return Boolean(state.isStreaming) || Boolean(state.isCompacting);
  }

  async interrupt(handle: RuntimeHandle): Promise<void> {
    await handleOf(handle)?.client.abort().catch(() => undefined);
  }

  async compact(handle: RuntimeHandle, instructions?: string): Promise<void> {
    await handleOf(handle)?.client.compact(instructions).catch(() => undefined);
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const h = handleOf(handle);
    if (!h) return null;
    const stats = (await h.client.getSessionStats().catch(() => null)) as {
      tokens?: { input?: number; output?: number; total?: number };
      cost?: number;
    } | null;
    if (!stats?.tokens) return null;
    const input = Number(stats.tokens.input ?? 0);
    const output = Number(stats.tokens.output ?? 0);
    return {
      contextTokens: h.lastTurn?.contextTokens ?? null,
      outputTokens: h.lastTurn?.outputTokens ?? null,
      totalTokens: Number(stats.tokens.total ?? input + output),
      costUsd: typeof stats.cost === 'number' ? stats.cost : null,
    };
  }

  async stop(handle: RuntimeHandle, _mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    // pi persists the session to ~/.pi/agent/sessions/<encoded-cwd>/ either way,
    // so hibernate and kill differ only in whether we expect to resume it.
    live.delete(handle.sessionId);
    await h.client.stop().catch(() => undefined);
  }
}
