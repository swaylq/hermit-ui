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

// RpcClient's default cliPath search is cwd-relative, so it looks for
// `<agentDir>/dist/cli.js` and dies. The package's `exports` map only defines
// the `import` condition, so require.resolve() cannot see it either — resolve
// through ESM and derive the sibling CLI entry.
const PI_CLI = path.join(
  path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
  'cli.js',
);

type PiHandle = RuntimeHandle & {
  client: RpcClient;
  /** externalIds already emitted — pi replays durable entries on reconnect. */
  seen: Set<string>;
  ordinal: number;
};

const live = new Map<string, PiHandle>();

function handleOf(handle: RuntimeHandle): PiHandle | null {
  return live.get(handle.sessionId) ?? null;
}

export class PiRpcRuntime implements AgentRuntime {
  readonly kind = 'pi-rpc' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    if (existing) return existing;

    const client = new RpcClient({
      cwd: session.agentDirectory,
      cliPath: PI_CLI,
      provider: session.provider ?? undefined,
      model: session.model ?? undefined,
    });
    await client.start();

    const state = (await client.getState().catch(() => null)) as { sessionId?: string } | null;

    const handle: PiHandle = {
      sessionId: session.id,
      externalSessionId: state?.sessionId ?? session.externalSessionId ?? '',
      client,
      seen: new Set<string>(),
      ordinal: 0,
    };
    live.set(session.id, handle);

    client.onEvent((ev: unknown) => {
      const raw = ev as { entryId?: string; id?: string } | null;
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
      inputTokens: input,
      outputTokens: output,
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
