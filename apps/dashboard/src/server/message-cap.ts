// Cap oversized content in a chat message so the timeline payload — and thus the
// time to OPEN a session — stays small. A handful of huge messages can otherwise
// make one session's listMessages 600KB+ (measured live: 6 messages = 611KB of a
// 641KB window, one 169KB), which the browser must download + parse before the
// conversation paints.
//
// The giants are almost always big TOOL OUTPUTS: a `tool_result` block (stored on
// a role:"user" message) whose `content` is a long string or text blocks — plus
// the occasional huge pasted `text` block. We truncate those to a generous cap
// that leaves every normal message untouched; other structured blocks (tool_use /
// image / file) pass through. The FULL content stays in the DB — this only trims
// what the timeline ships. Returns the SAME reference when nothing was truncated.
//
// MUST be applied identically in chat.listMessages AND /api/chat/stream so the
// client's merge-by-id sees the same (capped) rows over both transports.

const MAX_BLOCK_CHARS = 12000;

function note(fullLen: number): string {
  return `\n\n— 内容过长，面板已折叠显示（完整约 ${Math.round(fullLen / 1024)} KB，原始消息未改动）—`;
}

function capText(s: string): string {
  return s.length > MAX_BLOCK_CHARS ? s.slice(0, MAX_BLOCK_CHARS) + note(s.length) : s;
}

function capBlock(b: unknown): unknown {
  if (!b || typeof b !== 'object') return b;
  const block = b as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') {
    const capped = capText(block.text);
    return capped === block.text ? b : { ...block, text: capped };
  }
  // tool_result: the big tool outputs. `content` is a string or an array of
  // blocks — recurse so either shape gets trimmed.
  if (block.type === 'tool_result' && block.content !== undefined) {
    const capped = capMessageContent(block.content);
    return capped === block.content ? b : { ...block, content: capped };
  }
  return b;
}

export function capMessageContent(content: unknown): unknown {
  if (typeof content === 'string') return capText(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((b) => {
    const c = capBlock(b);
    if (c !== b) changed = true;
    return c;
  });
  return changed ? out : content;
}
