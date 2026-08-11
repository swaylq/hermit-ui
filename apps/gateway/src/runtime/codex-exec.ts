// codex backend: OpenAI's Codex CLI driven through @openai/codex-sdk.
//
// Unlike pi and omp there is no long-lived child to keep alive. The SDK runs
// one `codex exec` per turn and the conversation lives in codex's own thread
// store (`~/.codex/sessions/**/rollout-*-<threadId>.jsonl`), so "the session"
// here is a thread id plus whatever we remember about the last turn. That makes
// hibernate and restart nearly free — there is no process to drain — and it
// makes a gateway restart survivable without a pointer file: the thread id
// round-trips through the DB as the session's `claudeSessionId`, which is
// exactly what RuntimeSession.externalSessionId is for.
//
// Auth is codex's own (`codex login`, ~/.codex/auth.json), shared with the
// terminal CLI — so a session here draws on the same ChatGPT plan a human
// `codex` invocation does. Nothing about credentials is configured from the
// dashboard, which is why this backend has no equivalent of Settings → Pi
// Runtime.
//
// See docs/codex-runtime-design.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Codex, type Thread, type ThreadOptions, type Usage } from '@openai/codex-sdk';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { translateCodexEvent } from './codex-events';

/** Cumulative token counters, as codex reports them. */
type Totals = { input: number; output: number };

type CodexHandle = RuntimeHandle & {
  thread: Thread;
  /**
   * The thread id as the DB knows it.
   *
   * Separate from the readonly `externalSessionId` because it is learned, not
   * given: a brand-new session has none until codex reports one on the first
   * turn, and this is what says whether that has been stamped back yet.
   */
  stampedThreadId: string | null;
  /**
   * The RESOLVED model this thread object was built for (never null now that a
   * fleet default exists); a change rebuilds it.
   */
  model: string;
  emit: (item: SyncItem) => void;
  /** Set for the duration of a turn; the message queue's gate. */
  working: boolean;
  /** Aborts the in-flight turn. Null between turns. */
  abort: AbortController | null;
  /**
   * Cumulative usage as of the END of the last turn we saw.
   *
   * The subtrahend for the per-turn delta — see usageFromTurn for why a delta
   * is needed at all.
   */
  totals: Totals | null;
  /** Per-turn figures, which is what the context bar wants. */
  lastTurn: { contextTokens: number; outputTokens: number } | null;
  /** Monotonic per-session turn counter, for turn keys. */
  turnSeq: number;
};

const live = new Map<string, CodexHandle>();

function handleOf(h: RuntimeHandle): CodexHandle | null {
  return live.get(h.sessionId) ?? null;
}

function systemItem(sessionId: string, externalId: string, text: string): SyncItem {
  return { sessionId, role: 'system', content: [{ type: 'text', text }], externalId, claudeSessionId: null };
}

/** Where codex keeps its threads. `CODEX_HOME` relocates the whole directory. */
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/**
 * How a thread is run. Two of these are load-bearing:
 *
 * - `skipGitRepoCheck`, because `codex exec` refuses to start outside a git
 *   repo and most agent workspaces are not one. Without it every session on a
 *   plain directory dies at the first turn.
 * - the sandbox/approval pair, because there is nobody to answer an approval
 *   prompt. A dashboard session has no TTY: codex would block waiting for an
 *   answer that can never arrive and the turn would hang until it timed out.
 *   `never` + `danger-full-access` is the same posture the claude path takes
 *   with `--dangerously-skip-permissions` (chat-runner.ts) — these are trusted
 *   agents running on the user's own machine, and the fleet's protection is
 *   the workspace boundary, not the model's own restraint.
 *
 * Both sandbox and approval are overridable by env for a machine that wants a
 * tighter posture; the values are passed through untouched so codex validates
 * them rather than this file keeping a copy of its enum.
 */
/**
 * The model a session runs on when it pins none.
 *
 * codex's own default is whatever its config says, which on a fresh machine is
 * the newest model at its default effort — but "whatever the CLI felt like" is
 * not a fleet decision, and a machine with a stale ~/.codex/config.toml would
 * quietly run an older model than the one this was tuned for.
 *
 * gpt-5.6-sol is codex's own priority-1 entry, described in its model catalog
 * as "Latest frontier agentic coding model."
 */
const DEFAULT_MODEL = 'gpt-5.6-sol';

/**
 * Reasoning effort when the machine names none.
 *
 * The ladder is low → medium → high → xhigh → max → ultra, and the model's own
 * default is **low** — so a session left alone was running at the bottom of it.
 * `max` is "Maximum reasoning depth for the hardest problems"; `ultra` sits
 * above it but changes behaviour rather than just depth ("maximum reasoning
 * with automatic task delegation"), which is a different decision from turning
 * the dial up.
 *
 * Note this value is NOT in the SDK's ModelReasoningEffort union, which stops
 * at 'xhigh' — the published types lag the server's catalog. Verified against
 * codex-cli 0.147.0: a turn spawned with 'max' is accepted and its rollout
 * records `"effort": "max"` in the turn context. The cast below is therefore
 * load-bearing, not cosmetic; do not "fix" it by dropping back to xhigh.
 */
const DEFAULT_EFFORT = 'max';

/**
 * Session first (the dashboard's per-session model), then the machine's env,
 * then the fleet default.
 *
 * Shared with ensure(), which compares it against the model a live thread was
 * built for — resolving it in two places could disagree and either rebuild a
 * thread every tick or never rebuild one at all.
 */
export function resolveCodexModel(session: RuntimeSession): string {
  return session.model?.trim() || process.env.HERMIT_CODEX_MODEL?.trim() || DEFAULT_MODEL;
}

function threadOptions(session: RuntimeSession): ThreadOptions {
  const model = resolveCodexModel(session);
  const effort = process.env.HERMIT_CODEX_EFFORT?.trim() || DEFAULT_EFFORT;
  return {
    workingDirectory: session.agentDirectory,
    skipGitRepoCheck: true,
    sandboxMode: (process.env.HERMIT_CODEX_SANDBOX?.trim() || 'danger-full-access') as ThreadOptions['sandboxMode'],
    approvalPolicy: (process.env.HERMIT_CODEX_APPROVAL?.trim() || 'never') as ThreadOptions['approvalPolicy'],
    model,
    modelReasoningEffort: effort as ThreadOptions['modelReasoningEffort'],
  };
}

function client(): Codex {
  const override = process.env.HERMIT_CODEX_BIN?.trim();
  return new Codex(override ? { codexPathOverride: override } : {});
}

/**
 * The rollout file codex is writing for a thread, or null.
 *
 * Codex names it `rollout-<ISO timestamp>-<threadId>.jsonl` under
 * `<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/`, and a RESUMED thread appends to
 * the original file rather than starting a new one (measured: three turns
 * across two processes, one file). So the search is newest-day-first and stops
 * at the first hit — a thread resumed weeks later is found by walking back, and
 * the common case (today or yesterday) costs two readdirs.
 */
export function findRolloutFile(threadId: string, home = codexHome()): string | null {
  const root = path.join(home, 'sessions');
  const desc = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        const hit = names.find((n) => n.includes(threadId) && n.endsWith('.jsonl'));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** How much of a rollout file to read when looking for its last token_count. */
const ROLLOUT_TAIL_BYTES = 256 * 1024;

/**
 * The last token accounting codex wrote for a thread.
 *
 * Read only when the in-memory delta has no baseline — after a gateway
 * restart, a resumed thread's first `turn.completed` reports a cumulative total
 * with nothing to subtract from it, and reporting THAT as the context bar would
 * show a session at 58k the moment it woke up when its real occupancy was 14k.
 *
 * The file is a JSONL and only its tail is read: a long conversation's rollout
 * runs to megabytes and this is on the session-snapshot tick.
 */
export function readRolloutTokens(
  file: string,
): { total: Totals; lastTurn: { contextTokens: number; outputTokens: number } } | null {
  let buf: Buffer;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(Math.min(size, ROLLOUT_TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = buf.toString('utf8').split('\n');
  // Backwards: the last token_count is the current state of the thread.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('"token_count"')) continue;
    let info: {
      total_token_usage?: Record<string, number>;
      last_token_usage?: Record<string, number>;
    } | undefined;
    try {
      info = (JSON.parse(line) as { payload?: { info?: typeof info } })?.payload?.info;
    } catch {
      continue; // a truncated first line from the tail cut, or a shape we do not know
    }
    const total = info?.total_token_usage;
    const last = info?.last_token_usage;
    if (!total) continue;
    return {
      total: { input: Number(total.input_tokens ?? 0), output: Number(total.output_tokens ?? 0) },
      lastTurn: {
        contextTokens: Number(last?.input_tokens ?? 0),
        outputTokens: Number(last?.output_tokens ?? 0),
      },
    };
  }
  return null;
}

/**
 * Per-turn figures out of codex's CUMULATIVE counters.
 *
 * `TurnCompletedEvent.usage` is the thread's running total, not this turn's —
 * measured against codex-cli 0.144.1, where three trivial turns reported
 * input_tokens 28,916 → 43,477 → 58,065 and the rollout's own `last_token_usage`
 * for that third turn was 14,588, exactly 58,065 − 43,477.
 *
 * That distinction is the whole point of RuntimeUsage.contextTokens: it means
 * "how full is the window right now", and feeding it a cumulative total gives a
 * context bar that only ever fills up and then pins at 100% on a session whose
 * actual occupancy never moved.
 */
export function usageFromTurn(
  usage: Usage | null | undefined,
  previous: Totals | null,
): { totals: Totals; lastTurn: { contextTokens: number; outputTokens: number } } | null {
  if (!usage) return null;
  const totals: Totals = {
    input: Number(usage.input_tokens ?? 0),
    output: Number(usage.output_tokens ?? 0),
  };
  // No baseline: the whole cumulative IS this turn's, which is true for the
  // first turn of a fresh thread and the best available guess otherwise.
  // Negative deltas (a compaction shrank the thread, or codex reset its
  // counters) clamp to the raw total rather than rendering as a negative bar.
  const dIn = previous ? totals.input - previous.input : totals.input;
  const dOut = previous ? totals.output - previous.output : totals.output;
  return {
    totals,
    lastTurn: {
      contextTokens: dIn > 0 ? dIn : totals.input,
      outputTokens: dOut > 0 ? dOut : totals.output,
    },
  };
}

export class CodexExecRuntime implements AgentRuntime {
  readonly kind = 'codex-exec' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    const model = resolveCodexModel(session);
    if (existing) {
      // The model is baked into the Thread's options, so a switch needs a new
      // Thread object — but NOT a new conversation: it is rebuilt below with
      // resumeThread on the same id, so the history carries over. Never done
      // mid-turn; the running turn belongs to the old model and finishes on it.
      if (existing.model === model || existing.working) return existing;
      live.delete(session.id);
    }

    const codex = client();
    const threadId = session.externalSessionId?.trim() || null;
    const opts = threadOptions(session);
    const thread = threadId ? codex.resumeThread(threadId, opts) : codex.startThread(opts);

    // Seed the token baseline from codex's own file so the first turn after a
    // gateway restart reports a delta rather than the thread's whole history.
    let totals: Totals | null = null;
    let lastTurn: { contextTokens: number; outputTokens: number } | null = null;
    if (threadId) {
      const file = findRolloutFile(threadId);
      const seeded = file ? readRolloutTokens(file) : null;
      if (seeded) {
        totals = seeded.total;
        lastTurn = seeded.lastTurn;
      }
    }

    const handle: CodexHandle = {
      sessionId: session.id,
      externalSessionId: threadId ?? '',
      thread,
      stampedThreadId: threadId,
      model,
      emit,
      working: false,
      abort: null,
      totals,
      lastTurn,
      turnSeq: 0,
    };
    live.set(session.id, handle);
    return handle;
  }

  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    if (h.working) return false; // chat-runner gates on isWorking, but a racing tick must not double-submit

    const input = images.length > 0
      ? [
          { type: 'text' as const, text },
          ...images.map((i) => ({ type: 'local_image' as const, path: i.path })),
        ]
      : text;

    // Unique per turn and stable for its duration — the ids codex hands out are
    // per-turn ordinals, see codex-events.ts. The random suffix matters because
    // turnSeq restarts at 0 when the gateway does, and a resumed session's
    // "turn 0" would otherwise collide with the rows of the original turn 0.
    const turnKey = `${h.sessionId}:${h.turnSeq}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    h.turnSeq += 1;

    const abort = new AbortController();
    h.abort = abort;
    h.working = true;

    let stream: Awaited<ReturnType<Thread['runStreamed']>>;
    try {
      stream = await h.thread.runStreamed(input, { signal: abort.signal });
    } catch (e) {
      // Failed before the turn began — codex missing, not logged in, a thread
      // id it will not resume. Report it and leave the row un-acked so the next
      // tick retries rather than losing the user's message.
      h.working = false;
      h.abort = null;
      this.report(h, turnKey, e);
      return false;
    }

    // Consume in the background: chat-runner's tick must not block for the
    // length of a turn, and it already polls isWorking() to know when this ends.
    void (async () => {
      try {
        for await (const ev of stream.events) {
          if (ev.type === 'thread.started' && ev.thread_id) {
            // Stamp the thread id onto the session row so a gateway restart can
            // resume it. Emitted on EVERY turn, not just the first (measured),
            // and the sync route only writes when it differs — so this is
            // idempotent and also self-heals a session whose id drifted.
            if (ev.thread_id !== h.stampedThreadId) {
              h.stampedThreadId = ev.thread_id;
              h.emit({
                sessionId: h.sessionId,
                role: 'system',
                content: [{ type: 'text', text: `[codex thread ${ev.thread_id.slice(0, 8)}]` }],
                externalId: `${turnKey}:thread`,
                claudeSessionId: ev.thread_id,
              });
            }
            continue;
          }
          if (ev.type === 'turn.completed') {
            const next = usageFromTurn(ev.usage, h.totals);
            if (next) {
              h.totals = next.totals;
              h.lastTurn = next.lastTurn;
            }
            continue;
          }
          for (const item of translateCodexEvent(ev, turnKey)) {
            h.emit({ ...item, sessionId: h.sessionId, claudeSessionId: null });
          }
        }
      } catch (e) {
        // An abort lands here as a rejection; it is a user action, not a fault.
        if (abort.signal.aborted) {
          h.emit(systemItem(h.sessionId, `${turnKey}:interrupted`, '[turn interrupted]'));
        } else {
          this.report(h, turnKey, e);
        }
      } finally {
        h.working = false;
        if (h.abort === abort) h.abort = null;
      }
    })();

    return true;
  }

  /** Put a failure in the chat. Silence here reads as the agent ignoring you. */
  private report(h: CodexHandle, turnKey: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[codex] session=${h.sessionId.slice(0, 8)} turn failed:`, message);
    h.emit(systemItem(
      h.sessionId,
      `${turnKey}:error`,
      `[codex could not run this turn]\n${message.slice(0, 800)}`,
    ));
  }

  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    return handleOf(handle)?.working ?? false;
  }

  async interrupt(handle: RuntimeHandle): Promise<void> {
    const h = handleOf(handle);
    if (!h?.abort) return;
    h.abort.abort();
  }

  async compact(handle: RuntimeHandle, instructions?: string): Promise<void> {
    void instructions;
    const h = handleOf(handle);
    if (!h) return;
    // Codex compacts its own thread when the window fills and exposes no way to
    // ask for one. Saying so is better than a silent no-op: /compact appearing
    // to do nothing is indistinguishable, from the chat, from a wedged session.
    h.emit(systemItem(
      h.sessionId,
      `${h.sessionId}:compact-${Date.now()}`,
      '[codex manages its own context window — there is nothing to compact by hand]',
    ));
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const h = handleOf(handle);
    if (!h) return null;
    if (!h.totals && !h.lastTurn) return null;
    return {
      contextTokens: h.lastTurn?.contextTokens ?? null,
      outputTokens: h.lastTurn?.outputTokens ?? null,
      totalTokens: (h.totals?.input ?? 0) + (h.totals?.output ?? 0),
      // No per-token price to apply: these turns bill against the ChatGPT plan
      // behind `codex login`, and reporting a computed dollar figure would put
      // a number in the cost column that nobody is charged.
      costUsd: null,
    };
  }

  async stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    live.delete(handle.sessionId);
    h.abort?.abort();
    // Both modes keep the thread: the conversation lives in codex's own store
    // and the id is on the session row, so the next message resumes it. `kill`
    // is chat-runner's restart button — "unwedge this", not "forget this".
    void mode;
  }
}
