'use client';

// Lazy entry point for the chat / cron / brain markdown renderer. The real
// implementation (markdown-impl.tsx) pulls in react-markdown + rehype-highlight
// + a highlight.js language pack — ~370 KB, the single biggest JS chunk in the
// app. None of it is needed for the app shell or first paint, only once message
// bodies actually render, so it's split out behind React.lazy: the heavy deps
// leave the initial bundle (faster cold-start parse / TTI) and load as their own
// chunk. Until that chunk resolves, bubbles show their RAW text (prose reads fine
// unstyled); the first markdown render swaps in the rendered version. The service
// worker caches the chunk, so later cold-starts load it from disk.
//
// That swap is not free, so we start the fetch below the moment this module is
// evaluated. It used to be warmed on `requestIdleCallback`, which fires only
// AFTER first paint — on a cold /chat load that put the request at ~270ms, right
// as the bubbles were mounting, so the raw text painted first and the rendered
// markdown replaced it ~150ms later. Rendered markdown is a different height than
// its source (a pipe table collapses into a table, a fenced block into a code
// box), so that replacement re-laid out the whole timeline: 0.11 layout shift on
// every cold /chat load, the only route in the app that had any. Starting the
// fetch at module-evaluation time gets the chunk in place before the first bubble
// renders, so bubbles mount as markdown once and nothing moves.
//
// This does not add bytes to any route: the idle warm already fetched the chunk
// unconditionally wherever this module is imported, and only the timing changes.
// It is still a `lazy()` boundary, not a static import — the chunk stays out of
// every route's first-load script set, and a slow link simply falls back to the
// raw-text path exactly as before.

import { lazy, memo, Suspense } from 'react';

const MarkdownImpl = lazy(() => import('./markdown-impl'));

// Resolves to the SAME chunk React.lazy uses, so this is a head start, not a
// second download. Fire-and-forget: React.lazy owns the error path.
if (typeof window !== 'undefined') {
  void import('./markdown-impl');
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
