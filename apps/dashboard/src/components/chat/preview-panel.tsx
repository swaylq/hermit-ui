'use client';

// LivePreviewPanel — the iframe that shows what the agent mounted with
// `hermit-preview` (a static dir or a loopback service, served from the Mac at
// preview.swaylab.ai — a SEPARATE origin, deliberately: agent HTML must never
// run same-origin with the dashboard's localStorage key ring).
//
// One element, two shapes, CSS-only switch:
//   phone     fixed inset-0 full-screen layer (a split of 390px helps nobody)
//   lg+       a plain flex sibling right of the chat column, with a draggable
//             divider on its left edge — the chat stays fully usable, so the
//             human can watch the page while telling the agent what to change.
//
// Divider mechanics: pointer capture keeps the gesture alive across the iframe
// (which also goes pointer-events-none while dragging — an iframe otherwise
// swallows the move events the moment the cursor crosses into it). During the
// drag the width is written straight to a CSS variable via ref — React renders
// once at pointer-up, when the value is persisted. Double-click resets to the
// default 45% split; arrow keys nudge it for keyboard users.
//
// Chrome follows the house style (gallery/hermit.md): monochrome + hairline
// borders, mono type for the target path, a size-1.5 status dot instead of a
// colored pill, and the shared `breathe` dot while the iframe loads.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
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

// ── divider width persistence ────────────────────────────────────────────────

const W_KEY = 'hermit:live-preview-w';
const MIN_W = 320;
const MAX_W = 1100;
/** Keep this much room for the chat column (+ sidebar) no matter how far the divider goes. */
const CHAT_MIN = 480;

function clampW(w: number): number {
  const ceiling = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - CHAT_MIN));
  return Math.min(Math.max(MIN_W, Math.round(w)), ceiling);
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

  // Divider state. null = the default 45% split (no stored width). While a drag
  // is live the width goes straight to the CSS var through panelRef; React sees
  // one setWidth at pointer-up.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ on: false, startX: 0, startW: 0, lastW: 0 });

  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(W_KEY));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount gate reading window/localStorage
      if (Number.isFinite(v) && v >= MIN_W) setWidth(clampW(v));
    } catch {
      /* private mode / bad value */
    }
  }, []);

  // A window resize can leave a stored width overlapping the chat minimum —
  // re-clamp (listener callback, not effect body, so no cascading render).
  useEffect(() => {
    const onResize = () => setWidth((w) => (w == null ? w : clampW(w)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const persistWidth = useCallback((w: number | null) => {
    setWidth(w);
    try {
      if (w == null) localStorage.removeItem(W_KEY);
      else localStorage.setItem(W_KEY, String(w));
    } catch {
      /* private mode */
    }
  }, []);

  const onDividerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startW = panel.offsetWidth;
    drag.current = { on: true, startX: e.clientX, startW, lastW: startW };
    setDragging(true);
  }, []);

  const onDividerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    const panel = panelRef.current;
    if (!g.on || !panel) return;
    // The panel sits on the right, so dragging left grows it.
    g.lastW = clampW(g.startW + (g.startX - e.clientX));
    panel.style.setProperty('--pv-w', `${g.lastW}px`);
  }, []);

  const onDividerUp = useCallback(() => {
    const g = drag.current;
    if (!g.on) return;
    g.on = false;
    setDragging(false);
    persistWidth(g.lastW);
  }, [persistWidth]);

  const onDividerKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const cur = panelRef.current?.offsetWidth ?? MIN_W;
      // Panel on the right: ← widens the preview, → narrows it.
      persistWidth(clampW(cur + (e.key === 'ArrowLeft' ? 24 : -24)));
    },
    [persistWidth],
  );

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
      ref={panelRef}
      data-esc-layer=""
      style={width != null ? ({ '--pv-w': `${width}px` } as React.CSSProperties) : undefined}
      className={cn(
        'flex flex-col bg-background',
        // Phone: full-screen layer above the composer (z-50) and the FabDock (70),
        // below dialogs (100+). pwa-safe-* because fixed layers pad the notch /
        // home bar themselves (Sheet does; Overlay's children do).
        'fixed inset-0 z-[90] pwa-safe-t pwa-safe-b',
        // Desktop ≥lg: an in-flow flex column beside the chat (parent supplies
        // the row). relative (not static) so the divider handle can anchor to
        // its left edge; inset-auto neutralizes the phone layer's inset-0.
        'lg:relative lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l lg:border-border',
        width == null ? 'lg:w-[45%] lg:max-w-[720px]' : 'lg:w-[var(--pv-w)] lg:max-w-none',
        dragging && 'select-none',
      )}
    >
      {/* Divider handle: an 8px hit area straddling the hairline border. The
          visible line is the container's border-l; the ::after layer brightens
          it on hover/drag, the house way of saying "interactive" without color. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整预览宽度；← → 微调，双击恢复默认"
        tabIndex={0}
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerUp}
        onPointerCancel={onDividerUp}
        onDoubleClick={() => persistWidth(null)}
        onKeyDown={onDividerKey}
        className={cn(
          'absolute inset-y-0 left-0 z-20 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none lg:block',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors',
          dragging
            ? 'after:bg-foreground/30'
            : 'after:bg-transparent hover:after:bg-foreground/15 focus-visible:after:bg-foreground/30',
        )}
      />
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
            until the document loads, so dark mode never flashes white. While the
            divider drags, the iframe goes inert so it can't swallow the gesture. */}
        <iframe
          key={gen}
          src={preview.url}
          title="live preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          className={cn('h-full w-full border-0 bg-white', dragging && 'pointer-events-none')}
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
