'use client';

// LivePreviewPanel — the iframe that shows what the agent mounted with
// `hermit-preview` (a static dir or a loopback service, served from the Mac at
// preview.swaylab.ai — a SEPARATE origin, deliberately: agent HTML must never
// run same-origin with the dashboard's localStorage key ring).
//
// One element, two shapes, CSS-only switch:
//   phone     fixed inset-0 full-screen layer (a split of 390px helps nobody)
//   lg+       a plain flex sibling right of the chat column — the chat stays
//             fully usable, so the human can watch the page while telling the
//             agent what to change. That co-existence is the whole feature.
//
// Auto-refresh lives inside the iframe (the gateway injects an SSE client into
// served HTML), so this component stays dumb: src + a manual reload key.

import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, RotateCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface LivePreviewInfo {
  url: string;
  mode: 'static' | 'proxy';
  target: string;
  updatedAt?: string;
}

/** ChatSession.livePreview is an untyped Json column — validate at the edge. */
export function parseLivePreview(v: unknown): LivePreviewInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) return null;
  return {
    url: o.url,
    mode: o.mode === 'proxy' ? 'proxy' : 'static',
    target: typeof o.target === 'string' ? o.target : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
  };
}

export function LivePreviewPanel({ preview, onClose }: { preview: LivePreviewInfo; onClose: () => void }) {
  const [gen, setGen] = useState(0); // manual refresh = remount the iframe
  const [copied, setCopied] = useState(false);

  // Esc closes the panel. data-esc-layer (below) makes the chat page's
  // "Esc cancels the running turn" shortcut stand down while we're mounted —
  // same contract as Overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shortTarget = useMemo(() => preview.target.replace(/^\/Users\/[^/]+\//, '~/'), [preview.target]);

  return (
    <div
      data-esc-layer=""
      className={cn(
        'flex flex-col bg-background',
        // Phone: full-screen layer above the composer (z-50) and the FabDock (70),
        // below dialogs (100+). pwa-safe-* because fixed layers pad the notch /
        // home bar themselves (Sheet does; Overlay's children do).
        'fixed inset-0 z-[90] pwa-safe-t pwa-safe-b',
        // Desktop ≥lg: a static flex column beside the chat (parent supplies the row).
        'lg:static lg:inset-auto lg:z-auto lg:w-[45%] lg:max-w-[720px] lg:shrink-0 lg:border-l lg:border-border',
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            preview.mode === 'static'
              ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : 'border-sky-500/40 text-sky-600 dark:text-sky-400',
          )}
        >
          {preview.mode === 'static' ? 'static' : 'service'}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={preview.target}>
          {shortTarget}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setGen((g) => g + 1)}
            title="刷新预览"
            aria-label="刷新预览"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(preview.url).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                },
                () => {},
              );
            }}
            title={copied ? '已复制' : '复制预览链接'}
            aria-label="复制预览链接"
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer',
              copied ? 'text-emerald-500' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer noopener"
            title="在新标签页打开"
            aria-label="在新标签页打开预览"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={onClose}
            title="关闭预览面板 (Esc)"
            aria-label="关闭预览面板"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {/* bg-white: preview pages overwhelmingly assume a light ground; a dark
          flash between navigations reads as a broken page. The page's own CSS
          takes over the instant it paints. */}
      <iframe
        key={gen}
        src={preview.url}
        title="live preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
