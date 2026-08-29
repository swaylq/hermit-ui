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
//   3. the `signature` of a `thinking` block — the base64 blob the extended-thinking
//      API returns beside the reasoning text. Measured on the production DB
//      2026-08-29: 401 MB across 99,988 thinking blocks, against 10 MB of actual
//      reasoning text, and 94,246 of those blocks have NO text at all. The timeline
//      renders a thinking block as `💭 thinking · N chars`, and fold-runs drops the
//      step outright when N is 0 (fold-runs.ts:stepFor) — so for 94% of them we were
//      shipping ~4 KB to paint nothing. Nothing in this repo reads `signature`:
//      `--resume` replays the agent's own transcript under ~/.claude/projects, and
//      this column was only ever a display source. It is base64, so it does not
//      gzip either. Verified over all 648 sessions' newest-60 windows, gzipped:
//      36 → 14 KB at the median, 91 → 30 KB at p90, 172 → 67 KB at p99. The
//      digested history page (listMessagesBefore) goes 23 → 6 KB on the same set.
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

  // A thinking block's `signature` is never rendered and never read back — see
  // note 3 at the top. Drop it and keep the block otherwise intact, so an empty
  // thinking block becomes small enough that the digest can leave it alone.
  if (block.type === 'thinking' && typeof block.signature === 'string') {
    const rest = { ...block };
    delete rest.signature;
    return rest;
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

// ── Storage side ────────────────────────────────────────────────────────────
//
// `capMessageContent` above trims what the timeline SHIPS and leaves the row in
// the database whole. For one shape that is pure waste: a base64 image nested in
// a `tool_result` — an agent screenshot, or an image the agent Read — which the
// timeline renders as a text-only chip and therefore never displays. The read
// cap already throws those bytes away on every single read.
//
// Measured on the deploy box 2026-08-25: 1,552 MB of the 2,218 MB ChatMessage
// corpus was exactly this, in 7,205 blocks — 70% of the table, growing ~60 MB a
// day, and not one byte of it reachable from the UI. The agent's own transcript
// under ~/.claude/projects keeps the real copy, which is what `--resume` reads;
// this column was only ever a display source.
//
// So: drop the same bytes the reader would have dropped, before they are stored.
// What the timeline shows does not change — by construction, since the elided
// shape is the one `capBlock` already produces.
//
// The same argument now covers a second shape: a `thinking` block's `signature`.
// Measured 2026-08-29 — 401 MB of the 3,182 MB table, in 99,988 blocks, 94% of
// which carry no reasoning text at all, and no reader anywhere in this repo. It
// is base64, so it does not even compress on the way out. Stop storing it.
function dropBlock(b: unknown, insideToolResult: boolean): unknown {
  if (!b || typeof b !== 'object') return b;
  const block = b as Record<string, unknown>;

  if (block.type === 'thinking' && typeof block.signature === 'string') {
    const rest = { ...block };
    delete rest.signature;
    return rest;
  }

  if (insideToolResult && block.type === 'image' && block.source && typeof block.source === 'object') {
    const src = block.source as Record<string, unknown>;
    if (typeof src.data === 'string' && src.data.length > MAX_BLOCK_CHARS) {
      return { ...block, source: { ...src, data: '', elidedKB: Math.round(src.data.length / 1024) } };
    }
    return b;
  }

  if (block.type === 'tool_result' && block.content !== undefined) {
    const dropped = dropValue(block.content, true);
    return dropped === block.content ? b : { ...block, content: dropped };
  }

  return b;
}

function dropValue(content: unknown, insideToolResult: boolean): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((b) => {
    const c = dropBlock(b, insideToolResult);
    if (c !== b) changed = true;
    return c;
  });
  return changed ? out : content;
}

/**
 * Strip what the reader would have thrown away anyway, before it is written:
 * the base64 payload of images nested inside tool_result blocks, and the
 * `signature` of every thinking block. Top-level `image` blocks — user uploads
 * and agent attachments — are rendered, and pass through untouched. Returns the
 * SAME reference when there was nothing to drop.
 *
 * Name kept for its call sites; it has covered two shapes since 2026-08-29.
 */
export function dropStoredImageBytes(content: unknown): unknown {
  return dropValue(content, false);
}
