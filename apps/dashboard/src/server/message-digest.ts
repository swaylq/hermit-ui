// The digest projection: history as the collapsed timeline actually renders it.
//
// The timeline no longer draws one row per tool call — a stretch of machinery
// between two readable messages collapses into a single capsule (see
// components/chat/fold-runs.ts). Collapsed, that capsule shows tool NAMES, a
// one-line argument preview, an error count and a step count. Nothing else.
//
// Yet "load earlier" was shipping the whole thing. Measured on this machine's
// production DB (193k messages, 904 MB of `content`):
//
//   tool_result   621 MB      thinking   223 MB
//   tool_use       48 MB      text        11 MB   ← the conversation itself
//
// So a page of 60 raw messages costs ~1.1 MB to put ~13 readable rows on screen,
// and roughly none of that megabyte is ever painted. Digesting it server-side
// leaves the names and the first line — everything the collapsed capsule reads —
// and drops the bodies, which the client fetches per-capsule via
// `chat.getMessages` only if someone actually opens one.
//
// Applied AFTER capMessageContent, and only to history (`listMessagesBefore`).
// The live window stays full fidelity: it is what is streaming, what the user
// interacts with, and it is bounded at 60 rows anyway.
//
// Blocks that survive untouched: text · image · file · interaction. Those are
// the conversation and the things the reader has to act on — a screenshot the
// agent sent, a download chip, an unanswered question card.

/** Marks a block whose body was left behind on the server. */
export const DIGEST_FLAG = '__d';

// Below this, slimming a value costs more in confusion than it saves in bytes,
// and a block left whole needs no fetch to expand.
const KEEP_WHOLE = 200;
/** How much of a tool argument / result first line survives. */
const PREVIEW_CHARS = 180;

// The argument the chip shows, in the order tool-chips.ts:oneLineArg looks for
// them — the digest has to keep whichever key that function would have picked,
// or the collapsed row loses its subtitle.
const PREVIEW_KEYS = ['file_path', 'path', 'url', 'command', 'pattern', 'query', 'name', 'text', 'prompt', 'description'];

function clip(s: string, n = PREVIEW_CHARS): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + '…';
}

/** The single key/value pair a collapsed chip would have displayed. */
function slimInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const obj = input as Record<string, unknown>;
  for (const k of PREVIEW_KEYS) {
    if (typeof obj[k] === 'string') return { [k]: clip(obj[k] as string) };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') return { [k]: clip(v) };
  }
  return {};
}

/** Flatten a tool_result payload the way the chip's summary line does. */
function resultFirstLine(content: unknown): string {
  if (typeof content === 'string') return clip(content);
  if (Array.isArray(content)) {
    for (const b of content) {
      const x = b as { type?: unknown; text?: unknown } | null;
      if (x && typeof x === 'object' && x.type === 'text' && typeof x.text === 'string' && x.text.trim()) {
        return clip(x.text);
      }
    }
    return '';
  }
  if (content === undefined || content === null) return '';
  try {
    return clip(JSON.stringify(content));
  } catch {
    return '';
  }
}

function roughSize(v: unknown): number {
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function digestBlock(b: unknown): unknown {
  if (!b || typeof b !== 'object') return b;
  const block = b as Record<string, unknown>;

  if (block.type === 'thinking') {
    // Never kept: 223 MB of it, and the capsule shows only "💭 thinking · N chars".
    const body = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
    if (body.length === 0) return b;
    return { type: 'thinking', thinking: '', chars: body.length, [DIGEST_FLAG]: 1 };
  }

  if (block.type === 'tool_use') {
    if (roughSize(block.input) <= KEEP_WHOLE) return b;
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: slimInput(block.input),
      [DIGEST_FLAG]: 1,
    };
  }

  if (block.type === 'tool_result') {
    if (roughSize(block.content) <= KEEP_WHOLE) return b;
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      is_error: block.is_error ?? false,
      content: resultFirstLine(block.content),
      [DIGEST_FLAG]: 1,
    };
  }

  return b;
}

/**
 * Digest one message's content. Returns the SAME reference when nothing was
 * slimmed, so a prose-only page allocates nothing.
 */
export function digestMessageContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((b) => {
    const d = digestBlock(b);
    if (d !== b) changed = true;
    return d;
  });
  return changed ? out : content;
}
