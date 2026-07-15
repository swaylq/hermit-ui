// Shared pure helpers for the chat-timeline components (no React, no JSX).
// Extracted from chat/page.tsx (P2-3) so the split-out components can share them
// with the SessionPane core that stays behind.

// Flatten a message's content blocks to plain text — used to match an optimistic
// outbound row against its real counterpart once that lands in the query cache.
export function msgText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('').trim();
}

// Local-timezone date helpers for the message-timeline day dividers. Shared by
// MessageTimeline (day grouping, stays in page.tsx) and DateDivider (the label).
export function ymdLocal(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
}
export function isSameDay(a: Date | string, b: Date | string): boolean {
  const x = typeof a === 'string' ? new Date(a) : a;
  const y = typeof b === 'string' ? new Date(b) : b;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// A single content block in an assistant/user message (text / tool_use /
// tool_result / image / thinking). Shared by page.tsx and the message-render
// components split out of it.
export type Block = { type: string; text?: string; name?: string; input?: any; tool_use_id?: string; content?: any; source?: any; width?: number; height?: number };

// Claude Code's harness writes "No response requested." as the visible-text
// portion of an assistant turn whenever the model exited without producing
// substantive output — typically post-restart `--resume` picking up a half-
// finished tool task, a prompt the model read as pure instruction, or a turn
// killed mid-tool-call. It's a JSONL terminator marker, not the model's
// real reply. We keep the row visible (so the timeline doesn't lose a turn
// boundary), but swap the misleading text for an honest one-liner explaining
// what actually happened. Accepts accompanying thinking/empty blocks; bails
// on anything else (tool_use / tool_result / image / real text).
export function isHarnessTerminator(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  let sawTerminator = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') return false;
    if (b.type === 'thinking') continue;
    if (b.type === 'text') {
      const text = String(b.text ?? '').trim();
      if (!text) continue;
      if (/^no response requested\.?$/i.test(text)) {
        sawTerminator = true;
        continue;
      }
      return false;
    }
    return false;
  }
  return sawTerminator;
}
