// Drop the base64 payload of images nested in a `tool_result` before the block
// is pushed to the dashboard.
//
// These are agent screenshots and images the agent Read. The dashboard timeline
// renders a tool_result as a text-only chip, so it never displays them, and the
// dashboard's own read path (`message-cap.ts`) already throws the same bytes
// away on every read. Storing them cost 1,552 MB of a 2,218 MB table and grew
// ~60 MB a day; pushing them also sent that 60 MB a day up a home uplink to the
// VPS for nothing.
//
// The dashboard strips this again on receipt — that is the authoritative guard,
// covering machines running an older gateway. This copy exists to keep the bytes
// off the wire in the first place.
//
// Top-level `image` blocks are the agent's own attachments and the user's
// uploads. Those ARE displayed, and are left exactly alone.

const MAX_IMAGE_CHARS = 12_000;

function dropBlock(b: unknown, insideToolResult: boolean): unknown {
  if (!b || typeof b !== 'object') return b;
  const block = b as Record<string, unknown>;

  if (insideToolResult && block.type === 'image' && block.source && typeof block.source === 'object') {
    const src = block.source as Record<string, unknown>;
    if (typeof src.data === 'string' && src.data.length > MAX_IMAGE_CHARS) {
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

/** Same reference back when there was nothing to drop. */
export function stripToolResultImageBytes(content: unknown): unknown {
  return dropValue(content, false);
}
