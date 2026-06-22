'use client';

// Lazy entry point for the chat / cron / brain markdown renderer. The real
// implementation (markdown-impl.tsx) pulls in react-markdown + rehype-highlight
// + a highlight.js language pack — ~324 KB, the single biggest JS chunk in the
// app. None of it is needed for the app shell or first paint, only once message
// bodies actually render, so it's split out behind React.lazy: the heavy deps
// leave the initial bundle (faster cold-start parse / TTI) and load as their own
// chunk. Until that chunk resolves, bubbles show their RAW text (prose reads fine
// unstyled); the first markdown render swaps in the rendered version — a one-time,
// sub-second upgrade. The service worker caches the chunk, so later cold-starts
// load it from disk, and we warm it on idle below so the swap is usually invisible.

import { lazy, memo, Suspense } from 'react';

const MarkdownImpl = lazy(() => import('./markdown-impl'));

// Warm the chunk on idle (after first paint) so the first message render rarely
// hits the raw-text fallback. Runs once when this module is first evaluated; the
// dynamic import resolves to the SAME chunk React.lazy uses, so it's free.
if (typeof window !== 'undefined') {
  const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void };
  const warm = () => { void import('./markdown-impl'); };
  (w.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500)))(warm);
}

// Raw-text fallback, shown only while the markdown chunk is in flight (one-time
// per page load). whitespace-pre-wrap + a sans font keeps it readable and close to
// the rendered result, so the upgrade isn't jarring; it inherits the bubble color.
function RawText({ children }: { children: string }) {
  return (
    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[1.65]">
      {children}
    </div>
  );
}

// Memoized on the `children` string (markdown is a pure function of its source),
// so an unchanged bubble never re-enters Suspense or re-renders the impl — the
// same memoization the impl had, kept here at the split boundary.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<RawText>{children}</RawText>}>
      <MarkdownImpl>{children}</MarkdownImpl>
    </Suspense>
  );
});
