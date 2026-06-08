// Cap oversized text blocks in a chat message's content so the timeline payload
// — and therefore the time to OPEN a session — stays small. A handful of huge
// pasted user messages can otherwise make one session's listMessages 600KB+
// (measured live: 6 messages = 611KB of a 641KB window, one of them 169KB), which
// the browser must download + parse before the conversation paints.
//
// Only `type:"text"` blocks (and a plain-string content) are truncated, to a
// generous cap that leaves every normal message untouched; structured blocks
// (tool_use / tool_result / image / file) pass through unchanged. The FULL
// content stays in the DB — this only trims what the timeline ships. Returns the
// SAME reference when nothing was truncated, so normal messages allocate nothing.
//
// MUST be applied identically in chat.listMessages AND /api/chat/stream so the
// client's merge-by-id sees the same (capped) rows over both transports.

const MAX_BLOCK_CHARS = 12000;

function note(fullLen: number): string {
  return `\n\n— 内容过长，面板已折叠显示（完整约 ${Math.round(fullLen / 1024)} KB，原始消息未改动）—`;
}

export function capMessageContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return content.length > MAX_BLOCK_CHARS ? content.slice(0, MAX_BLOCK_CHARS) + note(content.length) : content;
  }
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((b) => {
    if (
      b &&
      typeof b === 'object' &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string' &&
      (b as { text: string }).text.length > MAX_BLOCK_CHARS
    ) {
      changed = true;
      const t = (b as { text: string }).text;
      return { ...(b as object), text: t.slice(0, MAX_BLOCK_CHARS) + note(t.length) };
    }
    return b;
  });
  return changed ? out : content;
}
