// claude-sdk backend: Claude Code driven through the official Agent SDK.
//
// The same product the tmux path runs — same binary, same tools, same skills,
// same CLAUDE.md, same subscription login — reached through its supported
// programmatic interface instead of by typing into its terminal UI.
//
// Why this exists, and why it did not before: until 2026-06-15 the SDK was
// understood to bill against a separate "Agent SDK" bucket at API rates, which
// is what put the fleet on `tmux send-keys` in the first place (see
// evolution/lessons.md → L1). Anthropic paused that split on the day it was due
// to take effect, and SDK traffic draws on the ordinary subscription windows
// again — verified on this fleet's own account, not inferred: an SDK turn
// reports `apiKeySource: none`, `subscriptionType: Claude Max`, and the SAME
// five_hour / seven_day utilisation windows an interactive session reports,
// with the would-be SDK bucket (`seven_day_oauth_apps`) null. The check is
// automated in collect/sdk-bucket.ts so the day it comes back is the day we
// hear about it rather than the day the bill arrives.
//
// What it buys, concretely — every one of these was a class of bug on the pane:
//   • the session id is HANDED to us at init, so nothing has to guess which
//     transcript a process is writing (no uuid drift, no resume sniffing, no
//     `ps`-argv archaeology, no two chats landing on one file);
//   • input is a function call, so a message cannot be swallowed by a TUI that
//     was not ready, or typed into a widget that stole focus, or lost to a
//     dropped keystroke — the failure mode that lost a user's message outright
//     on 2026-08-10 does not exist here;
//   • `interrupt()` is an RPC with a receipt instead of an Escape keypress;
//   • the model, the permission mode and the settings layer can change
//     MID-SESSION rather than requiring a respawn;
//   • slash-command output arrives as a message instead of being scraped off
//     the pane with `capture-pane` and a guess about when it finished.
//
// ── Two sources, one funnel ──────────────────────────────────────────────────
// The one thing a pane genuinely did better: it outlived the gateway. An SDK
// child is a gateway subprocess, so a gateway restart ends it, and any turn that
// completes in that gap would reach the transcript with nobody listening.
//
// So this runtime reads BOTH: the SDK message stream (live, typed, immediate)
// and a `tail -F` of the session's JSONL (the backstop that covers the gap).
// They carry the SAME records under the SAME uuids — the SDK's `uuid` IS the
// transcript's — so one `seen` set dedupes them exactly and whichever arrives
// first wins. The result is strictly more robust than either alone: the pane
// path had only the tail (seconds of latency, and every uuid-identification bug
// listed above), and an SDK-only path would silently drop a turn that landed
// while the gateway was down.
//
// See docs/claude-sdk-runtime-design.md.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  encodedProjectDir,
  resolveClaudeBin,
  watchTranscript,
  tmuxSessionExists,
  kill as killTmuxSession,
} from '@hermit-ui/tmux-driver';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { translateSdkMessage, contextTokensOf } from './claude-sdk-events';
import { buildMcpServers } from '../mcp-config';
import { AGENTS_ROOT, DASHBOARD_URL, ASST_KEY } from '../config';
import { CcBlock } from '../claude-code';

/** A uuid, exactly. Guards against another backend's session id in the shared column. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Cap for an image sent as a native `image` block.
 *
 * The Messages API rejects an over-large image, and a rejected block fails the
 * whole turn — so anything above this falls back to a `Read <path>` line, which
 * costs a tool round-trip but always works. 3.5 MB of source bytes lands under
 * the 5 MB base64 ceiling with room to spare.
 */
const MAX_INLINE_IMAGE_BYTES = 3_500_000;

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};

type Totals = { input: number; output: number };

type SdkHandle = RuntimeHandle & {
  q: Query;
  /** Push one user message into the query's input stream. */
  push: (m: SDKUserMessage) => void;
  /** Close the input stream (lets the CLI finish and exit cleanly). */
  endInput: () => void;
  emit: (item: SyncItem) => void;
  cwd: string;
  agentName: string;
  /** The claude session uuid, authoritative from the init message. */
  claudeUuid: string;
  /** Has claudeSessionId been stamped back to the DB yet? */
  stamped: boolean;
  /**
   * Records already forwarded, by uuid. Shared by the SDK stream and the JSONL
   * tail — the whole point of the two-source design.
   */
  seen: Set<string>;
  /** Turns submitted but not yet resulted. The message queue's gate. */
  pending: number;
  /** The CLI's own status frame ('requesting' | 'compacting' | null). */
  statusBusy: boolean;
  /**
   * A Stop the user asked for, awaiting the aborted turn's result.
   *
   * An interrupt surfaces as `error_during_execution`, which is indistinguishable
   * from a real failure by the time it reaches the translator — so without this
   * flag pressing Stop posts "⚠️ this turn did not finish normally" into the
   * chat, alarming the user about the thing they just did on purpose.
   */
  interrupting: boolean;
  lastUsage: { contextTokens: number; outputTokens: number } | null;
  totals: Totals;
  costUsd: number | null;
  /** Stops the JSONL backstop tail. */
  stopTail: () => void;
  closed: boolean;
  /** Monotonic counter behind the deterministic ids in claude-sdk-events. */
  seq: number;
  /** Set once the model is known, so a pin change can be applied without a respawn. */
  model: string | null;
};

const live = new Map<string, SdkHandle>();

/** Handles that have been closed but whose usage the collectors may still want. */
const lastKnownUsage = new Map<string, RuntimeUsage>();

function handleOf(h: RuntimeHandle): SdkHandle | null {
  const found = live.get(h.sessionId);
  return found && !found.closed ? found : null;
}

function systemItem(sessionId: string, externalId: string, text: string): SyncItem {
  return {
    sessionId, role: 'system',
    content: [{ type: CcBlock.text, text }],
    externalId, claudeSessionId: null,
  };
}

// ── The input stream ─────────────────────────────────────────────────────────

/**
 * A push-driven `AsyncIterable<SDKUserMessage>`.
 *
 * This is what makes the session long-lived: `query()` keeps the CLI alive for
 * as long as its input stream has not ended, so one query object serves the
 * whole conversation exactly the way one pane used to — rather than a process
 * per turn, which would re-read the whole transcript every time.
 */
function makeInput() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const stream = (async function* () {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((r) => { wake = r; });
    }
  })();

  return {
    stream,
    push(m: SDKUserMessage) {
      queue.push(m);
      const w = wake; wake = null; w?.();
    },
    end() {
      ended = true;
      const w = wake; wake = null; w?.();
    },
  };
}

// ── Content assembly ─────────────────────────────────────────────────────────

/**
 * Turn the gateway's (text, images) into Anthropic content blocks.
 *
 * Images go in as real `image` blocks. The pane could not do this at all —
 * `send-keys` carries no binary, so the tmux path appends a `Read <path>` line
 * and pays a tool round-trip per image before the model sees anything. Here the
 * bytes are in the first request.
 */
export function buildUserContent(text: string, images: RuntimeImage[]): any[] {
  const blocks: any[] = [];
  const fallbacks: string[] = [];

  for (const img of images) {
    const ext = (img.path.split('.').pop() || '').toLowerCase();
    const mediaType = img.mediaType || MEDIA_TYPES[ext];
    if (!mediaType || !mediaType.startsWith('image/')) {
      fallbacks.push(`Read ${img.path}`);
      continue;
    }
    let bytes: Buffer;
    try {
      const st = fs.statSync(img.path);
      if (st.size > MAX_INLINE_IMAGE_BYTES) {
        fallbacks.push(`Read ${img.path}`);
        continue;
      }
      bytes = fs.readFileSync(img.path);
    } catch {
      // Relay wrote it a moment ago; if it is unreadable now, let the model try
      // the path rather than dropping the attachment silently.
      fallbacks.push(`Read ${img.path}`);
      continue;
    }
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') },
    });
  }

  const textParts = [text.trim(), ...fallbacks].filter(Boolean);
  if (textParts.length > 0) blocks.push({ type: CcBlock.text, text: textParts.join('\n\n') });
  return blocks;
}

// ── Session identity ─────────────────────────────────────────────────────────

function transcriptPathFor(cwd: string, uuid: string): string {
  return path.join(encodedProjectDir(cwd), `${uuid}.jsonl`);
}

/**
 * Can we resume the recorded session id, and should we?
 *
 * `externalSessionId` is ONE column shared by every backend, so a session
 * switched here from codex or pi arrives still holding THAT backend's id.
 * Requiring a uuid AND an on-disk transcript covers both that case and the
 * genuine one the tmux path also has to handle: Claude Code prunes transcripts
 * on `cleanupPeriodDays`, so a long-idle session's history can simply be gone.
 * Either way the answer is the same — start fresh rather than fail forever.
 *
 * Exported for the unit test: "which conversation does this session resume" is
 * the single decision that, when wrong, loses a user's history.
 */
export function resumableUuid(cwd: string, recorded: string | null): string | null {
  const id = recorded?.trim();
  if (!id || !UUID_RE.test(id)) return null;
  try {
    return fs.statSync(transcriptPathFor(cwd, id)).size > 0 ? id : null;
  } catch {
    return null;
  }
}

// ── Message handling ─────────────────────────────────────────────────────────

/** The one funnel both sources go through. Dedupes on uuid, stamps once. */
function emitOnce(h: SdkHandle, item: SyncItem) {
  if (h.seen.has(item.externalId)) return;
  h.seen.add(item.externalId);
  const stamped: SyncItem = h.stamped
    ? { ...item, claudeSessionId: null }
    : { ...item, claudeSessionId: h.claudeUuid };
  if (!h.stamped) h.stamped = true;
  h.emit(stamped);
}

function onSdkMessage(h: SdkHandle, msg: SDKMessage) {
  const m = msg as any;

  // The init frame is the authoritative answer to "which transcript is this".
  // On the pane this took a uuid reservation table, a resume sniffer, an argv
  // parser and three incident write-ups; here it is a field.
  if (m.type === 'system' && m.subtype === 'init') {
    if (m.session_id && m.session_id !== h.claudeUuid) {
      h.claudeUuid = m.session_id;
      h.stamped = false;            // the DB has to learn the new one
      retail(h);                    // and the backstop has to follow it
    }
    if (typeof m.model === 'string') h.model = m.model;
    return;
  }

  if (m.type === 'system' && m.subtype === 'status') {
    h.statusBusy = m.status === 'requesting' || m.status === 'compacting';
    // fall through: translate ignores status frames, but a compact_boundary
    // arrives as its own message and does produce a row.
  }

  if (m.type === 'result') {
    h.pending = Math.max(0, h.pending - 1);
    h.statusBusy = false;
    if (h.interrupting) {
      h.interrupting = false;
      h.seq += 1;
      emitOnce(h, systemItem(
        h.sessionId,
        (m.uuid as string) || `sdk-stop-${h.sessionId}-${h.seq}`,
        '[gateway] ⏹️ 已停止',
      ));
      return;   // not a failure — the user asked for this
    }
    if (typeof m.total_cost_usd === 'number') h.costUsd = m.total_cost_usd;
    // `modelUsage`, not `usage`. They mean different things and only one of them
    // is what `totalTokens` is defined as ("cumulative for the whole session"):
    // `result.usage` is THIS turn's numbers, while `modelUsage` is the running
    // total. Measured across three turns: usage stayed at in=2/out=3 each time
    // while modelUsage went 19577 → 39186. Reading `usage` here would have made
    // the session total report the last turn's size forever.
    //
    // It is also the reading that survives a locally-answered command. A turn
    // the CLI handles itself (`/context`) reports a fully zeroed `usage` and
    // num_turns=0; modelUsage correctly does not move.
    //
    // Both this and costUsd restart from zero when a session is resumed in a new
    // process — the CLI's own lifecycle, shared with `total_cost_usd`. That is
    // why the context bar is driven by lastUsage instead: it is a property of
    // the conversation, not of how long this process has been watching it.
    const mu = m.modelUsage as Record<string, any> | undefined;
    if (mu) {
      let input = 0, output = 0;
      for (const v of Object.values(mu)) {
        input += (v?.inputTokens || 0) + (v?.cacheReadInputTokens || 0) + (v?.cacheCreationInputTokens || 0);
        output += v?.outputTokens || 0;
      }
      if (input + output > 0) h.totals = { input, output };
    }
  }

  const ctx = contextTokensOf(msg);
  if (ctx) h.lastUsage = ctx;

  h.seq += 1;
  for (const item of translateSdkMessage(msg, {
    sessionId: h.sessionId,
    stampUuid: null,               // emitOnce owns stamping
    seq: h.seq,
  })) {
    emitOnce(h, item);
  }
}

/**
 * The JSONL backstop.
 *
 * Same translation the SDK stream gets, fed from the transcript instead — so a
 * turn that completed while this gateway was down still reaches the dashboard on
 * the next attach. `tail -n +1` replays from line 1, which is exactly what makes
 * an unknown gap recoverable; the `seen` set and the sync route's upsert make
 * the overlap free.
 */
function retail(h: SdkHandle) {
  try { h.stopTail(); } catch { /* not started yet */ }
  if (!h.claudeUuid) { h.stopTail = () => {}; return; }
  const p = transcriptPathFor(h.cwd, h.claudeUuid);
  h.stopTail = watchTranscript(p, (ev) => {
    if (h.closed) return;
    if (!ev?.uuid || h.seen.has(ev.uuid)) return;
    // The transcript's record shape is the SDK's message shape — same `type`,
    // same `message`, same uuid — so one translator serves both.
    h.seq += 1;
    for (const item of translateSdkMessage(ev as any, {
      sessionId: h.sessionId, stampUuid: null, seq: h.seq,
    })) {
      emitOnce(h, item);
    }
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function teardown(h: SdkHandle, reason: string) {
  if (h.closed) return;
  h.closed = true;
  try { h.stopTail(); } catch { /* already down */ }
  try { h.endInput(); } catch { /* already ended */ }
  try { h.q.close(); } catch { /* already closed */ }
  if (live.get(h.sessionId) === h) live.delete(h.sessionId);
  lastKnownUsage.set(h.sessionId, {
    contextTokens: h.lastUsage?.contextTokens ?? null,
    outputTokens: h.lastUsage?.outputTokens ?? null,
    totalTokens: h.totals.input + h.totals.output,
    costUsd: h.costUsd,
  });
  console.log(`[claude-sdk] closed session=${h.sessionId.slice(0, 8)} (${reason})`);
}

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly kind = 'claude-sdk' as const;

  /**
   * Images reach the model as real content blocks here, so the chat runner must
   * hand over the relayed paths instead of replacing them with a vision
   * description the way it does for the backends that can only take text.
   */
  readonly acceptsImages = true;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    if (existing && !existing.closed) {
      // A model pin can change without touching the conversation — one control
      // request, no respawn. The pane had to be killed and re-created for this,
      // which is why switching models used to cost the session's warm context.
      const want = session.model?.trim() || null;
      if (want && want !== existing.model && existing.pending === 0) {
        try {
          await existing.q.setModel(want);
          existing.model = want;
          console.log(`[claude-sdk] session=${session.id.slice(0, 8)} model → ${want}`);
        } catch (e) {
          console.warn(`[claude-sdk] setModel failed:`, e);
        }
      }
      existing.emit = emit;
      return existing;
    }

    const cwd = session.agentDirectory ?? path.join(AGENTS_ROOT, session.agentName);
    fs.mkdirSync(encodedProjectDir(cwd), { recursive: true });

    // A session that just moved here from claude-tmux may still have its pane.
    // Both backends drive the same `<uuid>.jsonl`, so leaving the old process
    // holding it would put two Claude Codes on one transcript — the exact
    // cross-wiring the pane path spent three incidents learning to avoid, and
    // the reason this check does not trust the switch flow to have run: an
    // agent whose DEFAULT flips to claude-sdk reaches here without any switch
    // at all. Idempotent and ~5ms when there is no pane, which is the norm.
    if (tmuxSessionExists(session.id)) {
      console.warn(
        `[claude-sdk] session=${session.id.slice(0, 8)}: a tmux pane is still running for this ` +
        `session — killing it before resuming the same transcript through the SDK`,
      );
      await killTmuxSession(session.id, 2_000).catch(() => undefined);
    }

    const resume = resumableUuid(cwd, session.externalSessionId);
    // A fresh session pre-assigns its uuid, exactly as the tmux path does with
    // `--session-id`: the transcript path is then known before the first write,
    // so the backstop tail can attach immediately instead of racing the file.
    const freshUuid = resume ? null : randomUUID();
    if (session.externalSessionId && !resume) {
      console.warn(
        `[claude-sdk] session=${session.id.slice(0, 8)}: recorded id ` +
        `${session.externalSessionId.slice(0, 8)} is not a resumable claude transcript ` +
        `— starting a fresh session`,
      );
    }

    const input = makeInput();
    const q = query({
      prompt: input.stream,
      options: {
        cwd,
        pathToClaudeCodeExecutable: resolveClaudeBin(),
        ...(resume ? { resume } : { sessionId: freshUuid! }),
        // Matches the pane's `--dangerously-skip-permissions`: dashboard chat
        // sessions run gate-free, the same as the agents' own main sessions.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Matches the pane's `--effort max`.
        effort: 'max',
        ...(session.model?.trim() ? { model: session.model.trim() } : {}),
        mcpServers: buildMcpServers(session.id, session.isOrchestrator ?? false),
        env: {
          ...process.env,
          HERMIT_DASHBOARD_URL: DASHBOARD_URL,
          HERMIT_KEY: ASST_KEY,
          HERMIT_SESSION_ID: session.id,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
        // The transcript is the backstop AND what every collector reads; never
        // turn this off.
        persistSession: true,
        // Subagent output lands in the JSONL and the pane path forwarded it, so
        // forward it here too — otherwise a Task's work would vanish from chat
        // on the backends' only visible difference.
        forwardSubagentText: true,
        // Complete blocks only. The dashboard renders whole rows; partial chunks
        // would make every row rewrite itself token by token.
        includePartialMessages: false,
        // `settingSources` and `systemPrompt` are deliberately unset: omitted
        // means "all sources, Claude Code's own prompt", i.e. byte-identical to
        // what the pane's `claude` loads — CLAUDE.md, skills, hooks, plugins.
        // Verified rather than assumed (see the runtime test).
        //
        // Nothing may park a session waiting for a human: an unrecognised dialog
        // is answered 'cancelled', which tells the CLI to apply its own default.
        onUserDialog: async () => ({ behavior: 'cancelled' as const }),
      },
    });

    const h: SdkHandle = {
      sessionId: session.id,
      externalSessionId: resume ?? freshUuid!,
      q,
      push: input.push,
      endInput: input.end,
      emit,
      cwd,
      agentName: session.agentName,
      claudeUuid: resume ?? freshUuid!,
      stamped: !!session.externalSessionId && session.externalSessionId === (resume ?? freshUuid),
      seen: new Set<string>(),
      pending: 0,
      statusBusy: false,
      interrupting: false,
      lastUsage: null,
      totals: { input: 0, output: 0 },
      costUsd: null,
      stopTail: () => {},
      closed: false,
      seq: 0,
      model: session.model?.trim() || null,
    };
    live.set(session.id, h);
    retail(h);

    // The pump. Ends when the CLI exits — cleanly (we closed the input) or not
    // (crash, OOM, kill). Either way the handle is dropped so the next ensure()
    // resumes, and a turn cut off mid-flight is reported rather than lost in
    // silence: on the pane this case looked identical to "still thinking".
    void (async () => {
      try {
        for await (const msg of q) {
          if (h.closed) break;
          onSdkMessage(h, msg);
        }
        if (!h.closed && h.pending > 0) {
          emitOnce(h, systemItem(
            h.sessionId,
            `sdk-cut-${h.sessionId}-${Date.now()}`,
            '[gateway] ⚠️ 这一轮被中断了（claude 进程提前退出）。历史已保存，直接再发一条即可继续。',
          ));
        }
      } catch (e) {
        console.error(`[claude-sdk] stream error session=${session.id.slice(0, 8)}:`, e);
        if (!h.closed) {
          emitOnce(h, systemItem(
            h.sessionId,
            `sdk-err-${h.sessionId}-${Date.now()}`,
            `[gateway] ⚠️ claude 会话异常结束：${(e as Error).message}。历史已保存，再发一条会自动恢复。`,
          ));
        }
      } finally {
        teardown(h, 'stream ended');
      }
    })();

    console.log(
      `[claude-sdk] ${resume ? 'resumed' : 'started'} session=${session.id.slice(0, 8)} ` +
      `agent=${session.agentName} claude=${h.claudeUuid.slice(0, 8)}`,
    );
    return h;
  }

  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    const content = buildUserContent(text, images);
    if (content.length === 0) return false;
    try {
      h.pending += 1;
      h.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: h.claudeUuid,
      } as SDKUserMessage);
      return true;
    } catch (e) {
      h.pending = Math.max(0, h.pending - 1);
      console.error(`[claude-sdk] submit failed session=${h.sessionId.slice(0, 8)}:`, e);
      return false;
    }
  }

  /**
   * Biased toward busy, the safe direction for every caller: a turn wrongly
   * read as idle gets a message delivered into it, while one wrongly read as
   * busy just waits for the next ~2s tick.
   *
   * Two independent signals, ORed. `pending` covers a turn we started; the CLI's
   * own status frame covers one we did not — a cron fire, a `/loop` iteration, a
   * cross-session message — which is exactly the class the pane could only catch
   * by scraping a spinner off the screen.
   */
  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    return h.pending > 0 || h.statusBusy;
  }

  async interrupt(handle: RuntimeHandle): Promise<void> {
    const h = handleOf(handle);
    if (!h) return;
    try {
      // Set BEFORE the await: the aborted turn's result can land while
      // interrupt() is still resolving, and it must already read as deliberate.
      h.interrupting = true;
      await h.q.interrupt();
      h.pending = 0;
      h.statusBusy = false;
    } catch (e) {
      h.interrupting = false;
      console.error(`[claude-sdk] interrupt failed session=${h.sessionId.slice(0, 8)}:`, e);
    }
  }

  async compact(handle: RuntimeHandle, instructions?: string): Promise<void> {
    const h = handleOf(handle);
    if (!h) return;
    const cmd = instructions?.trim() ? `/compact ${instructions.trim()}` : '/compact';
    h.pending += 1;
    h.push({
      type: 'user',
      message: { role: 'user', content: [{ type: CcBlock.text, text: cmd }] },
      parent_tool_use_id: null,
      session_id: h.claudeUuid,
    } as SDKUserMessage);
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const h = handleOf(handle);
    if (!h) return null;
    return {
      contextTokens: h.lastUsage?.contextTokens ?? null,
      outputTokens: h.lastUsage?.outputTokens ?? null,
      totalTokens: h.totals.input + h.totals.output,
      costUsd: h.costUsd,
    };
  }

  /**
   * Token accounting for a session with no live handle — hibernated, or simply
   * not driven since this gateway started.
   *
   * The transcript is on disk and holds the same numbers, so a sleeping session
   * still renders its context bar instead of a blank one. Must not create a
   * handle: recovering usage may never wake a session.
   */
  async storedUsage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const cached = lastKnownUsage.get(handle.sessionId);
    if (cached) return cached;
    const id = handle.externalSessionId?.trim();
    if (!id || !UUID_RE.test(id)) return null;
    for (const root of agentDirsToSearch()) {
      const p = transcriptPathFor(root, id);
      const u = readLastUsage(p);
      if (u) {
        return { contextTokens: u.contextTokens, outputTokens: u.outputTokens, totalTokens: 0, costUsd: null };
      }
    }
    return null;
  }

  /**
   * The plan's rate-limit windows, read off any live session.
   *
   * A CONTROL request, not a model call: it costs no tokens and does not
   * disturb a running turn. It exists so collect/sdk-bucket.ts can watch for
   * the one policy change that would invalidate this whole backend — see there
   * for what is being watched and why.
   *
   * Returns null when no session is live (nothing to ask) or the CLI is too old
   * to answer. The underlying API is marked experimental by the SDK, so this is
   * a monitor, never a dependency.
   */
  async probeRateLimits(): Promise<{ sessionId: string; rateLimits: Record<string, any> } | null> {
    for (const h of live.values()) {
      if (h.closed) continue;
      try {
        const u = await (h.q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
        if (u?.rate_limits_available && u.rate_limits) {
          return { sessionId: h.sessionId, rateLimits: u.rate_limits as Record<string, any> };
        }
      } catch {
        // Old CLI, or a session shutting down mid-probe. Try the next one.
      }
    }
    return null;
  }

  async stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    // Both modes end the child; the difference is only what the caller does
    // next. Durable state is the transcript, which survives either way — so a
    // hibernate is genuinely free to take, and a restart genuinely gets a clean
    // process rather than the same wedged one the pane path used to leave behind.
    teardown(h, mode);
  }
}

// ── Transcript fallbacks (no live handle) ────────────────────────────────────

/**
 * Where to look for a transcript when we only hold a session id.
 *
 * `storedUsage` is called with a bare handle — no agent dir — so the project
 * directory has to be found rather than computed. Only the agent roots are
 * scanned, and only for an exact `<uuid>.jsonl`, so this is a handful of stats.
 */
function agentDirsToSearch(): string[] {
  try {
    return fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(AGENTS_ROOT, d.name));
  } catch {
    return [];
  }
}

/** Newest assistant usage in a transcript, in the context bar's terms. */
function readLastUsage(p: string): { contextTokens: number; outputTokens: number } | null {
  let lines: string[];
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      if (len === 0) return null;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: any;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    const got = contextTokensOf(ev);
    if (got) return got;
  }
  return null;
}

/** Close every live session. Called from the gateway's shutdown hook. */
export function shutdownClaudeSdk() {
  for (const h of [...live.values()]) teardown(h, 'gateway shutdown');
}
