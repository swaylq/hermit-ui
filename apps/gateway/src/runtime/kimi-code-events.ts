// Kimi Code CLI stream-json -> the Anthropic-native content blocks the
// dashboard renders. Same job as codex-events.ts and dsh-events.ts, for the
// same reason: the renderer understands `text`, `thinking`, `tool_use` and
// `tool_result` because that is what Claude Code's JSONL contains, and every
// other harness speaks its own vocabulary.
//
// `kimi -p … --output-format stream-json` writes one JSON object per line to
// STDOUT, in an OpenAI-chat-message shape (apps/kimi-code/src/cli/
// prompt-render.ts → PromptJsonWriter). Five line kinds exist and that is the
// whole protocol:
//
//   {"role":"meta","type":"system.version","version":"0.38.0"}
//   {"role":"assistant","content":"…","tool_calls":[{type,id,function:{name,arguments}}]}
//   {"role":"tool","tool_call_id":"…","content":"…"}
//   {"role":"meta","type":"turn.step.retrying",…}
//   {"role":"meta","type":"session.resume_hint","session_id":"session_…",…}
//
// Three things about it are load-bearing and not obvious:
//
//  · `content` and `tool_calls` are OMITTED when empty, and ONE assistant line
//    can carry both — the text the model wrote plus the calls it made in the
//    same step. So a line is up to two rows, not one.
//  · `function.arguments` is a JSON-ENCODED STRING, not an object.
//  · Thinking never appears. `writeThinkingDelta` is a no-op in JSON mode, so
//    there is no `thinking` block to translate and none is invented.
//
// The resume hint arrives LAST, not first — the opposite of dsh's `hello`. That
// is why ids here are scoped by a per-turn tag rather than by the session id:
// at the moment the first rows are emitted, a brand-new session does not have
// an id yet. See kimi-code.ts → spawnTurn.

import type { TranslatedItem } from './pi-events';

/** One `tool_calls` entry, as the CLI writes it. */
export type KimiToolCall = {
  type?: string;
  id?: string;
  function?: { name?: string; arguments?: string };
};

/** One parsed line of the stream-json protocol. */
export type KimiStreamLine = {
  role?: string;
  type?: string;
  content?: string;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
  /** meta/session.resume_hint */
  session_id?: string;
  /** meta/turn.step.retrying */
  failed_attempt?: number;
  next_attempt?: number;
  max_attempts?: number;
  delay_ms?: number;
  error_name?: string;
  error_message?: string;
  status_code?: number;
  version?: string;
};

/**
 * Parse one stdout line; null for anything that is not one of ours.
 *
 * Non-JSON lines are expected rather than exceptional. The CLI's own tool
 * output goes to stderr, but a hook, an MCP server or a plugin the agent
 * spawns inherits stdout, and one stray `console.log` must not end the turn.
 */
export function parseKimiLine(line: string): KimiStreamLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as KimiStreamLine;
    return typeof parsed?.role === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** The session id a resume_hint line names, or null for any other line. */
export function resumeHintId(msg: KimiStreamLine): string | null {
  if (msg.role !== 'meta' || msg.type !== 'session.resume_hint') return null;
  const id = msg.session_id?.trim();
  return id ? id : null;
}

type Block = Record<string, unknown>;

/**
 * Translates one TURN's line stream.
 *
 * An instance per turn, not per session: kimi issues globally unique tool-call
 * ids (`tool_<22 chars>`), so unlike dsh there is no cross-turn call map to
 * carry, and a fresh instance cannot orphan anything.
 */
export class KimiEventTranslator {
  private seq = 0;

  /** `tag` scopes every externalId; see the header note on the resume hint. */
  constructor(private readonly tag: string) {}

  private id(suffix = ''): string {
    return `kimi:${this.tag}:${this.seq++}${suffix}`;
  }

  translate(msg: KimiStreamLine): TranslatedItem[] {
    if (msg.role === 'assistant') return this.assistant(msg);
    if (msg.role === 'tool') return this.toolResult(msg);
    if (msg.role === 'meta') return this.meta(msg);
    // A role a newer CLI adds: dropped rather than passed through, because an
    // unrecognised block renders as an empty bubble — which reads as data loss
    // rather than as a new feature.
    return [];
  }

  /** Text and calls from one step. Either half may be absent; both may be present. */
  private assistant(msg: KimiStreamLine): TranslatedItem[] {
    const rows: TranslatedItem[] = [];

    const text = msg.content ?? '';
    if (text.trim()) {
      rows.push({
        role: 'assistant',
        content: [{ type: 'text', text } as Block],
        externalId: this.id(),
      });
    }

    for (const call of msg.tool_calls ?? []) {
      // kimi's own call id doubles as the tool_use id, so the paired result
      // line matches it without a lookup table. It is only missing if the CLI
      // ever emits a malformed line; a scoped fallback keeps that row visible
      // instead of dropping it.
      const toolUseId = call.id?.trim() || this.id(':call');
      rows.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: call.function?.name?.trim() || 'tool',
          input: parseArguments(call.function?.arguments),
        } as Block],
        externalId: this.id(`:${toolUseId}`),
      });
    }

    return rows;
  }

  private toolResult(msg: KimiStreamLine): TranslatedItem[] {
    const toolUseId = msg.tool_call_id?.trim();
    if (!toolUseId) return [];
    return [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: msg.content ?? '',
        // The protocol carries no error flag. A failed tool reports its failure
        // as text (the agent reads it and reacts), so claiming `is_error` here
        // would be a guess rendered as a fact.
        is_error: false,
      } as Block],
      externalId: this.id(`:${toolUseId}:result`),
    }];
  }

  private meta(msg: KimiStreamLine): TranslatedItem[] {
    // system.version and session.resume_hint are bookkeeping the runtime reads
    // directly; neither belongs in the chat.
    if (msg.type !== 'turn.step.retrying') return [];

    // A retry IS worth showing. It is the difference between a session that
    // looks hung and one that is waiting out a 429 — the single most common
    // thing a Kimi subscription does under load.
    const attempt = `attempt ${msg.failed_attempt ?? '?'}/${msg.max_attempts ?? '?'}`;
    const wait = msg.delay_ms ? `, retrying in ${Math.round(msg.delay_ms / 100) / 10}s` : '';
    const code = msg.status_code ? ` ${msg.status_code}` : '';
    const detail = msg.error_message?.trim() || msg.error_name?.trim() || '';
    return [{
      role: 'system',
      content: [{
        type: 'text',
        text: `[kimi — model call failed${code} (${attempt})${wait}]${detail ? `\n${detail.slice(0, 400)}` : ''}`,
      } as Block],
      externalId: this.id(':retry'),
    }];
  }
}

/**
 * `function.arguments` as an object.
 *
 * The raw string is kept under `arguments` when it will not parse, exactly as
 * dsh does: a model that emitted broken JSON is still worth showing, and an
 * empty `{}` would hide the bug in the one place it is visible.
 */
function parseArguments(raw: string | undefined): unknown {
  const text = raw ?? '';
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { arguments: parsed };
  } catch {
    return { arguments: text };
  }
}
