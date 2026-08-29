// Codex thread events -> the Anthropic-native content blocks the dashboard renders.
//
// Same job as pi-events.ts, and for the same reason: the dashboard's message
// renderer understands `text`, `thinking`, `tool_use` and `tool_result` because
// that is what Claude Code's JSONL contains. Codex models the conversation with
// its own vocabulary (`agent_message`, `command_execution`, `file_change`,
// `mcp_tool_call`, …), so this is where the two meet. A pure function with its
// own tests, because getting it wrong makes codex sessions render worse than
// claude ones and the failure shows up as an empty bubble rather than an error.
//
// ── The id trap ─────────────────────────────────────────────────────────────
// Codex item ids are a PER-TURN ordinal: `item_0`, `item_1`, `item_2`, and the
// next turn starts again at `item_0`. Measured against codex-cli 0.144.1 —
// three turns on one thread produced ids `item_0, item_1, item_2, item_0,
// item_0`. Since the dashboard upserts on (sessionId, externalId), using the
// raw id would make every turn's first message overwrite the previous turn's
// first message and the chat would keep only the newest turn.
//
// So every id here is scoped by a `turnKey` the caller mints per turn. That
// covers tool_use ids too, not just externalIds: a `tool_result` names its
// `tool_use_id`, and two turns both calling their first tool `item_1` would
// cross-link one turn's output under the other turn's command.
//
// Replay is NOT a concern here, unlike the pi path. A resumed codex thread
// emits only the new turn's items — measured: turn 3 of a resumed thread
// replayed none of turns 1-2 — so there is no history to dedupe against.

import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { TranslatedItem } from './pi-events';

type Block = Record<string, unknown>;

/** A tool call and (optionally) its result, as two chat rows. */
function toolRows(
  turnKey: string,
  id: string,
  name: string,
  input: unknown,
  result: { content: string; isError: boolean } | null,
): TranslatedItem[] {
  const toolUseId = `${turnKey}-${id}`;
  const rows: TranslatedItem[] = [{
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolUseId, name, input: input ?? {} }],
    externalId: toolUseId,
  }];
  if (result) {
    rows.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result.content,
        is_error: result.isError,
      }],
      // Its own row, so it needs its own id — the sync route upserts on
      // (sessionId, externalId) and sharing one would make the result replace
      // the call it belongs to.
      externalId: `${toolUseId}:result`,
    });
  }
  return rows;
}

/** A one-line summary of a patch, for the tool_result body. */
function patchSummary(changes: ReadonlyArray<{ path: string; kind: string }>): string {
  if (changes.length === 0) return 'no files changed';
  return changes.map((c) => `${c.kind} ${c.path}`).join('\n');
}

/**
 * Text out of an MCP tool result. The payload is MCP's own ContentBlock list,
 * where only `text` blocks have anything to render inline; an image block is
 * left to its own summary line rather than dumped as base64 into the chat.
 */
function mcpResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p: unknown) => {
      const block = p as { type?: string; text?: string };
      if (block?.type === 'text') return String(block.text ?? '');
      return block?.type ? `[${block.type}]` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Per-session dedupe for non-fatal error notices. Codex re-emits some warnings
 * on EVERY turn of a long thread — one session collected 20 copies of the same
 * "long threads" heads-up, each a `[codex error]` row in the chat. The first
 * copy of a given text is worth showing; the rest are noise. Returns true when
 * the row should be emitted, false when it is a repeat. Anything that is not a
 * non-fatal error row always passes.
 *
 * Session state lives in the caller (codex-exec's per-session handle), so this
 * stays a pure function of (seen, item) and the dedupe survives across turns of
 * one gateway process. A gateway restart shows the notice once more — after a
 * restart that is information, not spam.
 */
export function emitNoticeOnce(seen: Set<string>, item: TranslatedItem): boolean {
  if (item.role !== 'system') return true;
  // SyncItem.content is `unknown` at the type level; a caller that hands us a
  // non-array must not crash the turn's event loop.
  const block = (Array.isArray(item.content) ? item.content : [])[0] as { text?: unknown } | undefined;
  const text = typeof block?.text === 'string' ? block.text : '';
  if (!text.startsWith('[codex error]\n')) return true;
  if (seen.has(text)) return false;
  // A cap, so a codex build that invents a fresh warning every turn cannot grow
  // this set for the life of the process. Past the cap notices pass through —
  // spam is bad, but silently dropping an unseen warning is worse.
  if (seen.size >= 200) return true;
  seen.add(text);
  return true;
}

/**
 * One completed (or in-flight) thread item -> chat rows.
 *
 * `final` says whether the item has reached a terminal state. A non-final item
 * still produces its `tool_use` row so a long-running command is visible while
 * it runs — the row is upserted, not duplicated, when the item completes.
 */
function itemRows(item: ThreadItem, turnKey: string, final: boolean): TranslatedItem[] {
  const externalId = `${turnKey}-${item.id}`;

  switch (item.type) {
    case 'agent_message': {
      // Only when final: the streaming deltas arrive as item.updated with the
      // text so far, and syncing each one would rewrite the row on every token.
      if (!final) return [];
      const text = String(item.text ?? '');
      return text ? [{ role: 'assistant', content: [{ type: 'text', text }], externalId }] : [];
    }

    case 'reasoning': {
      if (!final) return [];
      const thinking = String(item.text ?? '');
      return thinking
        ? [{ role: 'assistant', content: [{ type: 'thinking', thinking }], externalId }]
        : [];
    }

    case 'command_execution':
      return toolRows(
        turnKey,
        item.id,
        // The dashboard renders a tool row by name, and every other backend in
        // the fleet calls this one Bash. Naming it the same means a codex
        // session's shell calls look like everyone else's rather than like an
        // unknown tool.
        'Bash',
        { command: item.command },
        final
          ? {
              content: String(item.aggregated_output ?? ''),
              // `status` is the authority; exit_code is absent while running and
              // a command killed by a signal reports failed with no code.
              isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
            }
          : null,
      );

    case 'file_change':
      return toolRows(
        turnKey,
        item.id,
        'apply_patch',
        { changes: item.changes },
        final
          ? { content: patchSummary(item.changes ?? []), isError: item.status === 'failed' }
          : null,
      );

    case 'mcp_tool_call':
      return toolRows(
        turnKey,
        item.id,
        // Same shape Claude Code gives MCP tools, so the dashboard's existing
        // `mcp__server__tool` handling applies unchanged.
        `mcp__${item.server}__${item.tool}`,
        item.arguments,
        final
          ? item.error
            ? { content: String(item.error.message ?? ''), isError: true }
            : { content: mcpResultText(item.result), isError: item.status === 'failed' }
          : null,
      );

    case 'web_search':
      // No result payload in the event stream — the search lands in the model's
      // context, not in ours — so the call row is the whole of it.
      return final ? toolRows(turnKey, item.id, 'WebSearch', { query: item.query }, null) : [];

    case 'todo_list':
      return final
        ? toolRows(turnKey, item.id, 'TodoWrite', { todos: item.items }, null)
        : [];

    case 'error':
      // Non-fatal: the turn carries on. A system row rather than an assistant
      // one, so it reads as the harness speaking and not as the model's answer.
      // Codex re-emits some of these every turn; codex-exec passes each row
      // through emitNoticeOnce so a repeat never reaches the chat.
      return final
        ? [{
            role: 'system',
            content: [{ type: 'text', text: `[codex error]\n${String(item.message ?? '')}` }],
            externalId,
          }]
        : [];

    default:
      // An item type this build of the SDK does not know is dropped rather than
      // passed through: an unrecognised block reaching the dashboard renders as
      // an empty bubble, which looks like data loss rather than a new feature.
      return [];
  }
}

/**
 * Translate one codex thread event into zero or more dashboard sync items.
 *
 * `turnKey` must be unique per turn and stable for its duration — see the id
 * trap above. The caller mints it at submit time.
 */
export function translateCodexEvent(ev: ThreadEvent, turnKey: string): TranslatedItem[] {
  if (!ev || typeof ev !== 'object') return [];

  switch (ev.type) {
    case 'item.started':
    case 'item.updated':
      return itemRows(ev.item, turnKey, false);

    case 'item.completed':
      return itemRows(ev.item, turnKey, true);

    case 'turn.failed':
      // A failed turn usually carries no assistant message at all, so without
      // this the user sends a message and the chat shows nothing whatsoever —
      // silence that reads as "the agent ignored me". Same reasoning as the pi
      // path's stopReason handling.
      return [{
        role: 'system',
        content: [{
          type: 'text',
          text: `[codex error — the turn did not complete]\n${
            String(ev.error?.message ?? '').trim() || 'no error message reported'
          }`,
        }],
        externalId: `${turnKey}:failed`,
      }];

    case 'error':
      return [{
        role: 'system',
        content: [{
          type: 'text',
          text: `[codex stream error]\n${String(ev.message ?? '').trim() || 'no error message reported'}`,
        }],
        externalId: `${turnKey}:stream-error`,
      }];

    // thread.started / turn.started / turn.completed carry no chat content —
    // the runtime reads the thread id and the usage off them directly.
    default:
      return [];
  }
}
