// The digest projection: history as the collapsed timeline actually renders it.
//
// The timeline no longer draws one row per tool call — a stretch of machinery
// between two readable messages collapses into a single capsule (see
// components/chat/fold-runs.ts). Collapsed, that capsule shows tool NAMES, a
// one-line argument preview, an error count and a step count. Nothing else.
//
// Yet "load earlier" was shipping the whole thing. Re-measured on the production
// DB 2026-08-29 (541,234 messages / 648 sessions, 2,018 MB of blocks — the
// numbers below replace the 193k-message set this file used to quote):
//
//   tool_result  1402 MB (69%)     thinking   418 MB (21%)
//   tool_use      164 MB ( 8%)     text        40 MB ( 2%)  ← the conversation
//
// So a page of 60 raw messages costs ~1.1 MB to put ~13 readable rows on screen,
// and roughly none of that megabyte is ever painted. Digesting it server-side
// leaves the names and the first line — everything the collapsed capsule reads —
// and drops the bodies, which the client fetches per-capsule via
// `chat.getMessages` only if someone actually opens one.
//
// Note what the `thinking` row of that table really is: 401 of those 418 MB are
// the `signature` blob, not reasoning text. `capMessageContent` now drops it on
// both the read and the write path (server/message-cap.ts, note 3), which is why
// the digest's own numbers below finally match its intent.
//
// Applied AFTER capMessageContent — always, through `messageProjection` at the
// bottom of this file, which is the only supported way to compose the two.
//
// It covers the LIVE window too, as of 2026-08-29. It used not to, on the
// grounds that the live window "is what is streaming, what the user interacts
// with, and it is bounded at 60 rows anyway"; measured, that bound is 14 KB at
// the median but 30 KB at p90 and 67 KB at p99 on the wire, paid on every
// session open and every machine switch. Streaming is unaffected because the
// digest never touches a `text` block.
//
// Blocks that survive untouched: text · image · file · interaction. Those are
// the conversation and the things the reader has to act on — a screenshot the
// agent sent, a download chip, an unanswered question card.
//
// …and the `ask` tool_use, for a reason that is not about bytes. The timeline
// joins an ask CALL to its interaction CARD on the question string itself
// (message-timeline.tsx: `askCardByQuestion` is keyed by `input.question`, looked
// up with `isAskToolUse(b) ? b.input.question : undefined`). `slimInput` both
// clips to PREVIEW_CHARS and collapses whitespace, so a digested call carries a
// question that no longer equals the card's — the lookup misses, the card is not
// swapped in at the call site, and the standalone system row is no longer
// suppressed either. The reader gets the card in its original too-early slot
// PLUS a bare `ask` chip. Measured on the production DB 2026-08-29: of 405 ask
// calls, 359 are large enough to be slimmed and 26 of those (a question over 180
// chars, or one containing a newline) mismatch. Pass it through whole; it is one
// block per question and the payload does not care.

import { isAskToolUse } from '@/components/chat/sink-deliverables';
import { capMessageContent } from './message-cap';

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
export const PREVIEW_KEYS = ['file_path', 'path', 'url', 'command', 'pattern', 'query', 'name', 'text', 'prompt', 'description'];

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
    // Never kept: the capsule shows only "💭 thinking · N chars".
    //
    // Returning an empty block by reference is only cheap because
    // `capMessageContent` runs first and has already taken the `signature` off
    // it — and 94% of thinking blocks in the DB are exactly that shape, an empty
    // body beside a 4 KB base64 signature. While the signature was still
    // attached, this early return handed history pages the whole 401 MB of it
    // and made the digest look like a 1.5x win instead of a 6x one. If this
    // function is ever called on raw column content, strip there too.
    const body = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
    if (body.length === 0) return b;
    return { type: 'thinking', thinking: '', chars: body.length, [DIGEST_FLAG]: 1 };
  }

  if (block.type === 'tool_use') {
    // The question card's join key. See the note at the top of this file.
    if (isAskToolUse(b)) return b;
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

/**
 * The projection a read endpoint applies to `content`, given whether the caller
 * asked for the digested shape.
 *
 * Exists so the cap-then-digest ORDER is written once. The digest returns an
 * empty thinking block by reference, so it can only be relied on to shed the
 * signature if the cap has already run — getting that backwards is what made a
 * digested history page carry all 401 MB of signature (see the thinking branch
 * above). Every read path — listMessages, listMessagesBefore, listMessagesAround
 * and /api/chat/stream — goes through here, which is also what keeps the SSE
 * delta byte-identical to the window it merges into.
 */
export function messageProjection(digest: boolean): (content: unknown) => unknown {
  return digest ? (c: unknown) => digestMessageContent(capMessageContent(c)) : capMessageContent;
}
