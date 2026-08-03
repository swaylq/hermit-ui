// pi session events -> the Anthropic-native content blocks the dashboard renders.
//
// The dashboard's message renderer understands `text`, `thinking`, `tool_use`
// and `tool_result` blocks because that is what Claude Code's JSONL contains.
// pi models the same conversation with different names, so this is where the
// two vocabularies meet. Getting it wrong makes pi sessions render worse than
// claude ones, which is why it is a pure function with its own tests rather
// than something buried in the RPC client wiring.

import type { SyncItem } from './types';

type Block = Record<string, unknown>;

/** What a translated event looks like before the caller attaches session ids. */
export type TranslatedItem = Omit<SyncItem, 'sessionId' | 'claudeSessionId'>;

/** Extract plain text from a pi tool result payload. */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && Array.isArray((result as any).content)) {
    return (result as any).content
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p.text ?? ''))
      .join('');
  }
  return '';
}

/**
 * One pi assistant content part -> one Anthropic-native block.
 *
 * Returns null for anything not renderable. Unknown block types are dropped
 * rather than passed through: a future pi block shape reaching the dashboard
 * raw would render as an empty bubble, which looks like data loss.
 */
function toBlock(part: any): Block | null {
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'text') {
    const text = String(part.text ?? '');
    return text ? { type: 'text', text } : null;
  }

  if (part.type === 'thinking') {
    return { type: 'thinking', thinking: String(part.thinking ?? '') };
  }

  if (part.type === 'toolCall') {
    return {
      type: 'tool_use',
      id: String(part.id ?? ''),
      name: String(part.name ?? ''),
      input: part.arguments ?? {},
    };
  }

  return null;
}

/**
 * Translate one pi session event into zero or more dashboard sync items.
 *
 * `externalId` must be stable for the event — chat-runner dedupes on it, and pi
 * replays durable session entries after a reconnect.
 */
export function translatePiEvent(ev: any, externalId: string): TranslatedItem[] {
  if (!ev || typeof ev !== 'object') return [];

  if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
    const parts = Array.isArray(ev.message.content) ? ev.message.content : [];
    const content = parts.map(toBlock).filter((b: Block | null): b is Block => b !== null);
    if (content.length === 0) return [];
    return [{ role: 'assistant', content, externalId }];
  }

  if (ev.type === 'tool_execution_end') {
    return [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: String(ev.toolCallId ?? ''),
        content: toolResultText(ev.result),
        is_error: Boolean(ev.isError),
      }],
      externalId,
    }];
  }

  // Everything else (streaming deltas, settle/idle, queue updates) is either
  // covered by message_end or has no durable representation in chat.
  return [];
}
