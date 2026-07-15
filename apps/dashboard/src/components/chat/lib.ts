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

// Local-timezone date helpers for the message-timeline day dividers. Shared by
// MessageTimeline (day grouping, stays in page.tsx) and DateDivider (the label).
export function ymdLocal(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
}
export function isSameDay(a: Date | string, b: Date | string): boolean {
  const x = typeof a === 'string' ? new Date(a) : a;
  const y = typeof b === 'string' ? new Date(b) : b;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
