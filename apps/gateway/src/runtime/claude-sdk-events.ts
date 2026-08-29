// SDKMessage → SyncItem translation for the claude-sdk runtime.
//
// The counterpart of chat-runner's `onTranscriptEvent`, and deliberately its
// twin: the Agent SDK hands us the SAME records the JSONL transcript holds —
// Anthropic-native content blocks under the SAME `uuid` — so the rows this
// produces are byte-for-byte what the tmux path produced for the same turn.
//
// That equivalence is not cosmetic. `/api/sync/chat-message` upserts on
// (sessionId, externalId), so a session MIGRATED from claude-tmux to claude-sdk
// re-emits its history onto the rows that already exist instead of duplicating
// them, and a session moved BACK lands on the same ids again. It is what makes
// the switch reversible per session rather than a one-way door.
//
// Pure and side-effect free so the whole vocabulary is unit-testable without a
// live claude — same split as pi-events.ts / codex-events.ts.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SyncItem } from './types';
import { CcBlock, hasToolResult } from '../claude-code';

/**
 * A message the CLI emitted but that carries no `uuid`.
 *
 * Every row we forward needs a STABLE externalId — it is the upsert key, so a
 * replay after a reconnect must land on the row it already wrote rather than a
 * new one. The SDK stamps `uuid` on everything that reaches the transcript;
 * what doesn't (a synthetic notice, a status frame) is either skipped outright
 * or given a deterministic id derived from the turn it belongs to.
 */
function fallbackId(sessionId: string, kind: string, seq: number): string {
  return `sdk-${sessionId}-${kind}-${seq}`;
}

function systemItem(
  sessionId: string,
  externalId: string,
  text: string,
  claudeSessionId: string | null,
): SyncItem {
  return {
    sessionId,
    role: 'system',
    content: [{ type: CcBlock.text, text }],
    externalId,
    claudeSessionId,
  };
}

export type TranslateCtx = {
  /** The hermit ChatSession id these rows belong to. */
  sessionId: string;
  /**
   * The claude session uuid to stamp onto the next row, or null once the DB
   * already has it. The dashboard's sync route records it on first non-null
   * arrival — the same first-arrival stamping the tmux path uses.
   */
  stampUuid: string | null;
  /** Monotonic counter for the deterministic ids above. */
  seq: number;
};

/**
 * One SDK message → the rows the dashboard should show for it.
 *
 * Returns [] for everything the chat surface does not render, which is most of
 * the union: partial-message chunks, hook lifecycle frames, task notifications,
 * status pings. Those drive the runtime's own state (see claude-sdk.ts) rather
 * than the transcript, and forwarding them would put noise in the chat that the
 * tmux path never showed.
 */
export function translateSdkMessage(msg: SDKMessage, ctx: TranslateCtx): SyncItem[] {
  const { sessionId, stampUuid } = ctx;
  const m = msg as any;

  // ── Assistant turn — text, thinking, tool_use ──────────────────────────────
  if (m.type === 'assistant') {
    const content = m.message?.content;
    if (!Array.isArray(content) || content.length === 0) return [];
    if (!m.uuid) return [];
    return [{
      sessionId,
      role: 'assistant',
      content,
      externalId: m.uuid,
      claudeSessionId: stampUuid,
    }];
  }

  // ── Tool results ──────────────────────────────────────────────────────────
  // Only user records that carry a tool_result. A plain user prompt is skipped
  // for the same reason the tmux path skips it: the dashboard already wrote that
  // row when it accepted the message, and re-syncing it would create a duplicate
  // under a different externalId.
  if (m.type === 'user') {
    const content = m.message?.content;
    if (!Array.isArray(content) || !hasToolResult(content)) return [];
    if (!m.uuid) return [];
    return [{
      sessionId,
      role: 'user',
      content,
      externalId: m.uuid,
      claudeSessionId: stampUuid,
    }];
  }

  if (m.type === 'system') {
    // Locally-produced command output.
    //
    // Most slash commands answer as ordinary assistant messages and need
    // nothing here (verified: `/context` arrives as an assistant text block).
    // This covers the frames the CLI emits directly instead. Either way the
    // point stands: on the tmux path NONE of this reached the JSONL, so the
    // output had to be scraped back off the pane with repeated `capture-pane`
    // calls plus a guess, from claude's own footer, about when it had finished.
    if (m.subtype === 'local_command_output') {
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      if (!text) return [];
      return [systemItem(
        sessionId,
        m.uuid || fallbackId(sessionId, 'cmdout', ctx.seq),
        `\`\`\`\n${text}\n\`\`\``,
        stampUuid,
      )];
    }

    // Compaction boundary. Worth a row: the context bar drops by a lot and the
    // user should be able to see why.
    if (m.subtype === 'compact_boundary') {
      const meta = m.compact_metadata ?? {};
      const pre = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null;
      const post = typeof meta.post_tokens === 'number' ? meta.post_tokens : null;
      const how = meta.trigger === 'manual' ? '手动' : '自动';
      const nums = pre != null && post != null
        ? `（${(pre / 1000).toFixed(0)}k → ${(post / 1000).toFixed(0)}k tokens）`
        : '';
      return [systemItem(
        sessionId,
        m.uuid || fallbackId(sessionId, 'compact', ctx.seq),
        `[gateway] 🗜️ 上下文已${how}压缩${nums}`,
        stampUuid,
      )];
    }

    return [];
  }

  // ── Turn outcome ──────────────────────────────────────────────────────────
  // Only the FAILURE side is forwarded. A successful result carries the final
  // assistant text, which already arrived as its own assistant row — posting it
  // again would double every reply. An error, though, is information the tmux
  // path could not surface at all: a rate limit or an API failure showed up
  // only in the pane, so from the dashboard the turn simply stopped.
  if (m.type === 'result') {
    if (!m.is_error && m.subtype === 'success') return [];
    const detail = typeof m.result === 'string' && m.result.trim()
      ? m.result.trim()
      : String(m.subtype ?? 'error');
    return [systemItem(
      sessionId,
      m.uuid || fallbackId(sessionId, 'result', ctx.seq),
      `[gateway] ⚠️ 这一轮没有正常结束：${detail}`,
      stampUuid,
    )];
  }

  return [];
}

/**
 * Context-window occupancy of the newest model call, in the same terms the
 * tmux path derives from the transcript: prompt + both cache halves.
 *
 * "How full is the window right now", NOT what the turn cost. Summing across
 * calls would climb forever and render as a context bar that only fills up.
 * Returns null for a message that carries no usage, so callers keep the last
 * good reading rather than blanking the bar mid-turn.
 */
export function contextTokensOf(msg: SDKMessage): { contextTokens: number; outputTokens: number } | null {
  const m = msg as any;

  // A compaction boundary is newer than the assistant message before it and
  // states the post-compaction size directly — the one case where the newest
  // assistant usage is stale by construction.
  if (m.type === 'system' && m.subtype === 'compact_boundary') {
    const post = m.compact_metadata?.post_tokens;
    if (typeof post === 'number' && post > 0) return { contextTokens: post, outputTokens: 0 };
    return null;
  }

  if (m.type !== 'assistant') return null;
  const u = m.message?.usage;
  if (!u) return null;
  const contextTokens =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0);
  // A zeroed reading is not a measurement of an empty window — it is a message
  // that never went to a model. Claude Code answers `/context`, `/status` and
  // friends LOCALLY and still emits them as assistant messages, carrying a
  // usage object with every field 0. Letting that through blanks the context
  // bar of a session that is in fact 20k tokens deep, and it stays blank until
  // the next real turn. There is no real model call with a zero prompt — the
  // system prompt alone is thousands of tokens — so this can only ever reject
  // the synthetic case.
  if (contextTokens === 0) return null;
  return { contextTokens, outputTokens: u.output_tokens || 0 };
}

// ── The live block ───────────────────────────────────────────────────────────
//
// With `includePartialMessages` on, the CLI narrates each content block as it is
// generated: content_block_start, a run of content_block_delta, content_block_stop.
// The finished block then arrives as an ordinary `assistant` record with its own
// uuid — one record PER BLOCK, sharing the message's `msg_…` id (measured against
// 2.1.238: a thinking block and a text block came through as two records, two
// uuids, one message id).
//
// That shape is why the partial cannot simply be the eventual row arriving early.
// The row identity used everywhere else — chat rows, the `seen` set, the JSONL
// backstop — is the record's uuid, and the uuid does not exist until the block is
// finished. Every partial frame carries its OWN uuid instead, so keying the
// growing row on one would produce a row per token.
//
// So the growth goes into a placeholder that is explicitly retracted. The
// placeholder's id is per session, not per block, so at most one exists at a
// time and cleaning up after a crashed gateway is a single delete.

export type LiveBlock = { index: number; kind: 'text' | 'thinking'; text: string };
export type LiveState = { block: LiveBlock | null };

export function newLiveState(): LiveState {
  return { block: null };
}

/** The one row a session streams into. Per session, so it cannot accumulate. */
export function liveExternalId(sessionId: string): string {
  return `sdk-live-${sessionId}`;
}

/**
 * Fold one SDK message into the live block.
 *
 * 'grew'  — the block has more text; the caller should schedule a push.
 * 'ended' — there is nothing live any more; the caller should retract.
 * null    — not a partial frame, or a frame that changes nothing.
 */
export function applyStreamEvent(state: LiveState, msg: SDKMessage): 'grew' | 'ended' | null {
  const m = msg as any;
  if (m?.type !== 'stream_event') return null;
  const ev = m.event;
  if (!ev) return null;

  if (ev.type === 'content_block_start') {
    const kind = ev.content_block?.type;
    // Only prose streams. A tool_use block arrives as input_json_delta — half a
    // JSON object is not something to show anyone, and the finished tool call
    // lands as its own record moments later anyway.
    state.block = kind === 'text' || kind === 'thinking'
      ? { index: typeof ev.index === 'number' ? ev.index : 0, kind, text: '' }
      : null;
    return state.block ? null : 'ended';
  }

  if (ev.type === 'content_block_delta') {
    const b = state.block;
    if (!b) return null;
    if (typeof ev.index === 'number' && ev.index !== b.index) return null;
    const d = ev.delta;
    const piece = d?.type === 'text_delta' ? d.text
      : d?.type === 'thinking_delta' ? d.thinking
      : null;
    if (typeof piece !== 'string' || piece === '') return null;
    b.text += piece;
    return 'grew';
  }

  if (ev.type === 'content_block_stop' || ev.type === 'message_stop') {
    if (!state.block) return null;
    state.block = null;
    return 'ended';
  }

  return null;
}

/**
 * The placeholder row, as the chat surface should currently render it.
 *
 * A THINKING block sends its length and not its text, because that is all the
 * reader is shown: the timeline folds thinking into a run capsule whose
 * collapsed label is `💭 thinking · N chars`, and there is no way to expand a
 * placeholder — it is retracted and replaced by the real record the moment the
 * block finishes.
 *
 * The text was costing a lot for that number. The push is trailing-edge at
 * LIVE_PUSH_MS (250 ms), so a block streams about four frames a second, each
 * carrying the WHOLE accumulation so far — quadratic in the block's length, and
 * every frame is an HTTP POST from the gateway on the Mac to the dashboard on
 * the VPS, plus a row rewrite in Postgres. An eight-second thinking block
 * ending at 4 KB spent roughly 32 posts and ~64 KB doing it. Now it is ~32
 * posts of a two-digit number, and Postgres rewrites a tiny row.
 *
 * TEXT still carries its text: that one IS rendered, token by token, and is
 * what the typewriter reveals.
 */
export function liveItem(sessionId: string, block: LiveBlock): SyncItem {
  return {
    sessionId,
    role: 'assistant',
    content: block.kind === 'thinking'
      // `chars` is the field fold-runs.ts:stepFor reads in preference to the
      // body, and the same shape server/message-digest.ts produces — so the
      // capsule cannot tell a live thinking block from a digested historical
      // one, which is the point.
      ? [{ type: 'thinking', thinking: '', chars: block.text.length }]
      : [{ type: 'text', text: block.text }],
    externalId: liveExternalId(sessionId),
    claudeSessionId: null,
    transient: true,
  };
}

/** Take the placeholder away. Idempotent at the dashboard: a miss writes nothing. */
export function liveRetraction(sessionId: string): SyncItem {
  return {
    sessionId,
    role: 'assistant',
    content: [],
    externalId: liveExternalId(sessionId),
    claudeSessionId: null,
    deleted: true,
  };
}
