'use client';

// One-line pub/sub for "open the global search". A window event rather than a
// React context: the triggers (a sidebar button, the ⌘K handler) and the host
// (mounted once in providers) sit in unrelated parts of the tree, and threading
// a provider through everything to carry a single boolean isn't worth it.

const OPEN_EVENT = 'hermit:open-search';

export function openGlobalSearch(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function onOpenGlobalSearch(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(OPEN_EVENT, fn);
  return () => window.removeEventListener(OPEN_EVENT, fn);
}
