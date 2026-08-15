// dsh session events -> the Anthropic-native content blocks the dashboard
// renders. Same job as codex-events.ts, for the same reason: the renderer
// understands `text`, `thinking`, `tool_use` and `tool_result` because that is
// what Claude Code's JSONL contains, and dsh speaks its own vocabulary
// (assistant/message with typed content blocks, tool/call + tool/result pairs).
//
// The events arrive verbatim from hermit-runner.mjs, which forwards dsh's
// SessionEvent {seq, type, data} for the handful of types worth rendering.
//
// ── ids ─────────────────────────────────────────────────────────────────────
// dsh's `seq` is monotonic per DSH session — perfect within one, but a chat
// session that is switched away and back gets a FRESH dsh session whose seq
// restarts low, and the dashboard upserts on (sessionId, externalId). So every
// id is scoped by a tag of the dsh session id (`sessionTag`), the same reason
// codex ids are scoped by a per-turn key.
//
// A tool_result names its call by dsh's provider-issued callId, which is NOT
// unique across turns (same trap as codex's per-turn item ordinals). The
// translator therefore carries a callId -> tool_use id map; calls always
// precede their results inside a turn, and the map lives for the process
// lifetime of the handle, so a lookup can only miss if the gateway restarted
// mid-turn — in which case the turn died with its child anyway.

import type { TranslatedItem } from './pi-events';

/** dsh's disjoint per-call token accounting (dsh-llm TokenUsage). */
export type DshUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

/** One line of the runner's reporting protocol. */
export type DshRunnerLine =
  | { hermit: 'hello'; sessionId: string; resumed: boolean; totals: DshTotals | null }
  | { hermit: 'event'; seq: number; type: string; data: unknown }
  | { hermit: 'done'; reason: { kind?: string; error?: { code?: string; message?: string } } | null; totals: DshTotals | null };

/** The runner's cumulative usage report (sumUsage in hermit-runner.mjs). */
export type DshTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The latest call's own accounting — the context bar's basis. */
  last: DshUsage | null;
};

/** Parse one line of runner output; null for anything that is not ours. */
export function parseRunnerLine(line: string): DshRunnerLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"hermit"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { hermit?: unknown };
    if (parsed.hermit === 'hello' || parsed.hermit === 'event' || parsed.hermit === 'done') {
      return parsed as DshRunnerLine;
    }
  } catch {
    // A dsh plugin's own stdout line; not for us.
  }
  return null;
}

type Block = Record<string, unknown>;

/** Content blocks of a dsh assistant/tool message. */
type DshBlock = { type?: string; text?: string; content?: DshBlock[] } & Record<string, unknown>;

function textOf(blocks: unknown, type: 'text' | 'reasoning'): string {
  if (!Array.isArray(blocks)) return '';
  return (blocks as DshBlock[])
    .filter((b) => b?.type === type)
    .map((b) => String(b.text ?? ''))
    .join('');
}

/**
 * Text out of a tool-result's content list. Only text blocks render inline;
 * any other block type is left as a summary marker rather than dumped raw.
 */
function resultText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return (blocks as DshBlock[])
    .map((b) => (b?.type === 'text' ? String(b.text ?? '') : b?.type ? `[${b.type}]` : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Translates one dsh session's event stream. An instance per runtime handle:
 * the callId map must survive across turns (each turn is its own child
 * process, but the handle — and the chat — span them).
 */
export class DshEventTranslator {
  /** `session-<uuid>` -> a short stable id prefix; see the header comment. */
  private readonly tag: string;

  private readonly toolUseIds = new Map<string, string>();

  constructor(dshSessionId: string) {
    this.tag = dshSessionId.replace(/^session-/, '').slice(0, 8) || 'nosess';
  }

  private id(seq: number, suffix = ''): string {
    return `dsh:${this.tag}:${seq}${suffix}`;
  }

  translate(seq: number, type: string, data: unknown): TranslatedItem[] {
    const d = (data ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'assistant/message': {
        // One event per model call, content already assembled — no streaming
        // deltas to debounce. tool-call blocks inside the content are skipped:
        // the paired tool/call event renders them (with the result attached).
        const message = d.message as { content?: unknown } | undefined;
        const rows: TranslatedItem[] = [];
        const thinking = textOf(message?.content, 'reasoning');
        if (thinking) {
          rows.push({
            role: 'assistant',
            content: [{ type: 'thinking', thinking } as Block],
            externalId: this.id(seq, ':think'),
          });
        }
        const text = textOf(message?.content, 'text');
        if (text) {
          rows.push({
            role: 'assistant',
            content: [{ type: 'text', text } as Block],
            externalId: this.id(seq),
          });
        }
        return rows;
      }

      case 'tool/call': {
        const callId = String(d.callId ?? '');
        const toolUseId = this.id(seq);
        if (callId) this.toolUseIds.set(callId, toolUseId);
        let input: unknown;
        try {
          input = JSON.parse(String(d.arguments ?? '{}'));
        } catch {
          // The raw string exactly as the model produced it — dsh deliberately
          // does not parse it either, and a broken JSON is still worth showing.
          input = { arguments: String(d.arguments ?? '') };
        }
        return [{
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: String(d.name ?? 'tool'), input: input ?? {} } as Block],
          externalId: toolUseId,
        }];
      }

      case 'tool/result': {
        const message = d.message as { content?: unknown; source?: { callId?: string } } | undefined;
        const error = d.error as { name?: string; code?: string } | undefined;
        // The call id lives on the message source AND on each tool-result
        // block (toolCallId); read either so a shape change in one spot does
        // not orphan every result row.
        const blockCallId = Array.isArray(message?.content)
          ? (message?.content as DshBlock[]).map((b) => b?.toolCallId).find((v) => typeof v === 'string')
          : undefined;
        const callId = String(message?.source?.callId ?? blockCallId ?? '');
        const toolUseId = this.toolUseIds.get(callId) ?? this.id(seq, ':orphan');
        // The result's content is a ToolResultMessage: user-role, whose blocks
        // are tool-result wrappers around the actual content list.
        const inner = Array.isArray(message?.content)
          ? (message?.content as DshBlock[]).flatMap((b) => (b?.type === 'tool-result' ? (b.content ?? []) : [b]))
          : [];
        return [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: resultText(inner),
            is_error: error !== undefined,
          } as Block],
          externalId: this.id(seq),
        }];
      }

      case 'todo/write':
        return [{
          role: 'assistant',
          content: [{ type: 'tool_use', id: this.id(seq), name: 'TodoWrite', input: { todos: d.todos ?? [] } } as Block],
          externalId: this.id(seq),
        }];

      case 'turn/end': {
        // A completed turn already said everything through its messages. Any
        // other ending usually carries no assistant text at all, so without
        // this row the user's message would be answered by silence.
        const reason = d.reason as { kind?: string; error?: { code?: string; message?: string } } | undefined;
        if (!reason?.kind || reason.kind === 'completed') return [];
        const detail = reason.error ? `\n${reason.error.code ?? ''}: ${reason.error.message ?? ''}`.trimEnd() : '';
        return [{
          role: 'system',
          content: [{ type: 'text', text: `[dsh — the turn ended: ${reason.kind}]${detail}` } as Block],
          externalId: this.id(seq),
        }];
      }

      default:
        // turn/start and anything a newer dsh adds: dropped rather than passed
        // through — an unrecognised block renders as an empty bubble, which
        // reads as data loss rather than a new feature.
        return [];
    }
  }
}
