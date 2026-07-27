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

export function extractSearchText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object') {
      const block = b as { type?: unknown; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}

// The renderable blocks a summary reader would see that are NOT prose.
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
