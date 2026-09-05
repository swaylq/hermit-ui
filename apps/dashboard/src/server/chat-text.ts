// Searchable plain text for a chat message — the projection the browser's local
// cache stores for full-history search.
//
// ONLY `text` blocks. That's the conversation itself: what the user typed and
// what the agent said back. Measured live on the production DB (193k messages,
// 158 sessions): text blocks total 11 MB, while tool_result totals 621 MB and
// thinking 223 MB. Shipping the whole content column to every browser would mean
// ~900 MB; shipping just the prose means ~11 MB, which fits an IndexedDB store
// with room to spare and stays scannable in a Worker. That ratio — 1.2% — is the
// entire reason full-history local search is affordable at all.
//
// Blocks are joined with a newline, NOT concatenated (the way components/chat/
// lib.ts:msgText does for display). A query must not match across a block
// boundary and invent a hit that exists in no single block.
//
// What counts as a `text` block is `lib/chat-blocks.ts`'s call, not this
// file's: it is the same question the iOS cache asks (`ContentBlock.text`),
// and the two answers have to be one answer or a phone's local search finds
// rows the browser's does not.

import { blockText, parseBlocks } from '../lib/chat-blocks';

export function extractSearchText(content: unknown): string {
  return parseBlocks(content)
    .map(blockText)
    .filter((t) => t.trim())
    .join('\n')
    .trim();
}

// The renderable blocks a summary reader would see that are NOT prose.
//
// NOTE (2026-08-21): summary mode is gone, and `summary-page.ts` — the only
// consumer of the `blocks` this produces — went with it. The projection is still
// WRITTEN into the local cache (chat.syncText → CachedText.blocks) and nothing
// reads it back. It is kept rather than removed because dropping the field would
// invalidate every browser's prose cache (~11 MB refetch each) to save a few
// hundred bytes per session. Delete it the next time that cache is versioned
// for another reason.
//
// Interaction cards — a permission request, a question and the option that was
// chosen — are real conversation: they are what the agent asked and what the
// person answered. They carry no `text` block, so the prose projection above
// misses them, and history served from the cache would quietly lose them
// (measured: 0–6 per session, every no-prose system row in a 336-row sample).
//
// Kept as blocks rather than flattened to text so the timeline renders the same
// card it renders from the server.
export function extractInteractionBlocks(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'interaction'
  );
}
