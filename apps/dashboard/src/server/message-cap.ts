// Cap oversized content in a chat message so the timeline payload — and thus the
// time to OPEN a session — stays small. A handful of huge messages can otherwise
// make one session's listMessages 600KB+ (measured live: 6 messages = 611KB of a
// 641KB window). The giants are almost always:
//   1. base64 IMAGES nested inside a `tool_result` block (agent screenshots,
//      ~170KB each). The timeline renders tool_results as text-only chips
//      (InlineToolResult → extractToolResultText), so these image bytes are
//      NEVER displayed — pure download weight. We drop the base64 data.
//   2. long `text` blocks / tool_result text (big pasted content or tool output).
//      Truncated to a generous cap with an inline note.
//
// IMPORTANT: only images INSIDE a tool_result are stripped — top-level `image`
// blocks (user attachments) ARE rendered, so those pass through untouched. Other
// structured blocks (tool_use / file) pass through. The FULL content stays in the
// DB; this only trims what the timeline ships. Returns the SAME reference when
// nothing was truncated.
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

function capBlock(b: unknown, insideToolResult: boolean): unknown {
  if (!b || typeof b !== 'object') return b;
  const block = b as Record<string, unknown>;

  if (block.type === 'text' && typeof block.text === 'string') {
    const capped = capText(block.text);
    return capped === block.text ? b : { ...block, text: capped };
  }

  // base64 image bytes inside a tool_result are never rendered → drop the data,
  // keep the shape + a size marker. Top-level images (insideToolResult=false) are
  // shown, so they're left intact.
  if (insideToolResult && block.type === 'image' && block.source && typeof block.source === 'object') {
    const src = block.source as Record<string, unknown>;
    if (typeof src.data === 'string' && src.data.length > MAX_BLOCK_CHARS) {
      return { ...block, source: { ...src, data: '', elidedKB: Math.round(src.data.length / 1024) } };
    }
    return b;
  }

  // tool_result content is a string or an array of blocks — recurse, marking that
  // we're now inside a tool_result so nested images get stripped.
  if (block.type === 'tool_result' && block.content !== undefined) {
    const capped = capValue(block.content, true);
    return capped === block.content ? b : { ...block, content: capped };
  }

  return b;
}

function capValue(content: unknown, insideToolResult: boolean): unknown {
  if (typeof content === 'string') return capText(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((b) => {
    const c = capBlock(b, insideToolResult);
    if (c !== b) changed = true;
    return c;
  });
  return changed ? out : content;
}

export function capMessageContent(content: unknown): unknown {
  return capValue(content, false);
}
