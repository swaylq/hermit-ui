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
// Chrome follows the house style (gallery/hermit.md): monochrome + hairline
// borders, mono type for the target path, a size-1.5 status dot instead of a
// colored pill, and the shared `breathe` dot while the iframe loads — the same
// keyframe as the thinking indicator, so "loading" reads the same everywhere.
//
// Auto-refresh lives inside the iframe (the gateway injects an SSE client into
// served HTML), so this component stays dumb: src + a manual reload key.

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, RotateCw, X } from 'lucide-react';
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

/** Header icon button — mirrors file-preview's header controls exactly. */
function HeaderButton({
  onClick,
  title,
  children,
  className,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground',
        'transition-colors cursor-pointer hover:bg-accent/40 hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function LivePreviewPanel({ preview, onClose }: { preview: LivePreviewInfo; onClose: () => void }) {
  const [gen, setGen] = useState(0); // manual refresh = remount the iframe
  const [copied, setCopied] = useState(false);
  // Covers the iframe with the panel's own background until the document fires
  // onLoad — without it, opening the panel in dark mode flashes a white block
  // before the preview paints. Reset on every remount (refresh).
  const [loaded, setLoaded] = useState(false);

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

  const shortTarget = useMemo(() => preview.target.replace(/^\/(Users|home)\/[^/]+\//, '~/'), [preview.target]);

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
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {/* live dot + mode, the house status idiom: a dot and a tracked label,
            never a colored pill. emerald = the registration is live. */}
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
          {preview.mode === 'static' ? 'static' : 'service'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={preview.target}>
          {shortTarget}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderButton
            title="刷新预览"
            onClick={() => {
              setLoaded(false);
              setGen((g) => g + 1);
            }}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </HeaderButton>
          <HeaderButton
            title={copied ? '已复制' : '复制预览链接'}
            className={copied ? 'text-emerald-500 hover:text-emerald-500' : undefined}
            onClick={() => {
              navigator.clipboard?.writeText(preview.url).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                },
                () => {},
              );
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </HeaderButton>
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer noopener"
            title="在新标签页打开"
            aria-label="在新标签页打开预览"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent/40 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <HeaderButton title="关闭预览面板 (Esc)" onClick={onClose}>
            <X className="h-4 w-4" />
          </HeaderButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* bg-white on the iframe itself: preview pages overwhelmingly assume a
            light ground. The overlay below (panel-colored) is what the user sees
            until the document loads, so dark mode never flashes white. */}
        <iframe
          key={gen}
          src={preview.url}
          title="live preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          className="h-full w-full border-0 bg-white"
          onLoad={() => setLoaded(true)}
        />
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center bg-background',
            'transition-opacity duration-300',
            loaded ? 'opacity-0' : 'opacity-100',
          )}
        >
          <span className="inline-block size-2 rounded-full bg-foreground/60 motion-safe:animate-[breathe_1.4s_ease-in-out_infinite]" />
        </div>
      </div>
    </div>
  );
}
