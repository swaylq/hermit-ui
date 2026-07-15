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
