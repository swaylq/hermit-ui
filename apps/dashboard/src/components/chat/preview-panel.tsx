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
//
// Back / forward / picker all run through the bridge script the preview server
// injects into every page it serves (apps/gateway/src/preview/bridge.ts). Being
// a different origin, this side cannot read the frame's history or its DOM — it
// asks, and the page answers over postMessage:
//
//   panel → page   nav{delta} · reload · pick{on} · hello
//   page  → panel  state{url,len,can} · picked{selector} · pick-cancel
//
// The page posts to '*' (it does not know who embedded it), so THIS side does
// the authenticating: origin must be the preview's, source must be our own
// contentWindow. Everything the page sends is treated as display data.
//
// Back is the one command that can hurt: an iframe traversing one entry past
// its own first walks the joint session history and takes the dashboard with
// it. So Back is only sent while `back` below says an entry exists — from the
// Navigation API where the browser has it, otherwise from counting pushes
// (history.length rising) against traversals we asked for ourselves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, RotateCw, SquareDashedMousePointer, X } from 'lucide-react';
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
  disabled = false,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground',
        'transition-colors cursor-pointer hover:bg-accent/40 hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-30',
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── the page bridge ──────────────────────────────────────────────────────────

const MSG_DOWN = 'hermit-preview'; // panel → page
const MSG_UP = 'hermit-preview-page'; // page → panel
/** A traversal that draws no answer stops counting, rather than skewing the next push. */
const NAV_ANSWER_MS = 2_500;
/** Shown on the three controls the bridge drives when this preview has none. */
const NO_BRIDGE = '本次预览未注入脚本（hermit-preview --no-reload），前进后退与元素选择不可用';

interface PageState {
  url?: unknown;
  len?: unknown;
  can?: unknown;
}

/** What the page says about itself. Untrusted input from a cross-origin frame — validate every field. */
function readPageState(d: PageState): { len: number | null; can: { back: boolean; fwd: boolean } | null } {
  const len = typeof d.len === 'number' && Number.isFinite(d.len) ? d.len : null;
  const c = d.can as { back?: unknown; fwd?: unknown } | null | undefined;
  const can = c && typeof c.back === 'boolean' ? { back: c.back, fwd: c.fwd === true } : null;
  return { len, can };
}

/**
 * How far into the preview we have wandered, as a path to show beside the
 * target. Empty at the entry page — a back button with no sense of where you
 * are is half a browser, but "/" on the front page is noise.
 */
function subPath(url: unknown, root: string): string {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    const base = new URL(root);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return '';
    const rest = u.pathname.slice(base.pathname.length) + u.search + u.hash;
    return rest === '' || rest === 'index.html' ? '' : `/${rest.replace(/^\//, '')}`;
  } catch {
    return '';
  }
}

export function LivePreviewPanel({
  preview,
  onClose,
  onPickSelector,
}: {
  preview: LivePreviewInfo;
  onClose: () => void;
  /** A picked element's CSS selector, on its way to the composer. */
  onPickSelector?: (selector: string) => void;
}) {
  const [gen, setGen] = useState(0); // hard refresh = remount the iframe
  const [copied, setCopied] = useState(false);
  // Covers the iframe with the panel's own background until the document fires
  // onLoad — without it, opening the panel in dark mode flashes a white block
  // before the preview paints. Reset on every remount (refresh).
  const [loaded, setLoaded] = useState(false);

  // Bridge state. `ready` flips on the page's first word — until then (and
  // forever, under --no-reload, which suppresses the injection) the three
  // bridge-driven controls are visibly dead rather than quietly broken.
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [picking, setPicking] = useState(false);
  // On a phone the panel covers the composer, so a selector landing in it is
  // invisible. Say so for a moment, then get out of the way.
  const [picked, setPicked] = useState<string | null>(null);
  const [nav, setNav] = useState({ back: false, fwd: false });
  const [here, setHere] = useState('');
  // Where we think we are in the frame's own history, for browsers with no
  // Navigation API. idx/max are positions, `pending` is a traversal we asked
  // for and have not seen answered, `len` the last history.length we were told.
  const hist = useRef({ idx: 0, max: 0, pending: null as number | null, seq: 0, len: null as number | null });

  const origin = useMemo(() => {
    try {
      return new URL(preview.url).origin;
    } catch {
      return '';
    }
  }, [preview.url]);

  const post = useCallback(
    (msg: Record<string, unknown>) => {
      const w = frameRef.current?.contentWindow;
      if (!w || !origin) return;
      try {
        w.postMessage({ source: MSG_DOWN, v: 1, ...msg }, origin);
      } catch {
        /* frame gone mid-click */
      }
    },
    [origin],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!origin || e.origin !== origin) return;
      if (e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { source?: unknown; type?: unknown; selector?: unknown } & PageState;
      if (!d || d.source !== MSG_UP) return;

      if (d.type === 'state') {
        setReady(true);
        const h = hist.current;
        const { len, can } = readPageState(d);
        const pending = h.pending;
        h.pending = null;
        if (pending != null) {
          h.idx = Math.max(0, Math.min(h.max, h.idx + pending));
        } else if (h.len != null && len != null && len > h.len) {
          // An entry appeared that we did not ask for: a link was followed, so
          // whatever was ahead of us is gone.
          h.idx += 1;
          h.max = h.idx;
        }
        h.len = len;
        setNav(can ?? { back: h.idx > 0, fwd: h.idx < h.max });
        setHere(subPath(d.url, preview.url));
      } else if (d.type === 'picked') {
        setPicking(false);
        if (typeof d.selector === 'string' && d.selector) {
          onPickSelector?.(d.selector);
          setPicked(d.selector);
        }
      } else if (d.type === 'pick-cancel') {
        setPicking(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, onPickSelector, preview.url]);

  useEffect(() => {
    if (!picked) return;
    const t = window.setTimeout(() => setPicked(null), 2_200);
    return () => window.clearTimeout(t);
  }, [picked]);

  const go = useCallback(
    (delta: -1 | 1) => {
      const h = hist.current;
      const seq = ++h.seq;
      h.pending = delta;
      window.setTimeout(() => {
        if (h.seq === seq) h.pending = null;
      }, NAV_ANSWER_MS);
      post({ type: 'nav', delta });
    },
    [post],
  );

  const togglePick = useCallback(() => {
    const on = !picking;
    setPicking(on);
    post({ type: 'pick', on });
  }, [picking, post]);

  // Reload through the bridge where we can — it keeps the history the back
  // button depends on. Without a bridge there is only the blunt instrument:
  // throw the frame away and build a new one.
  const refresh = useCallback(() => {
    if (ready) {
      post({ type: 'reload' });
      return;
    }
    hist.current = { idx: 0, max: 0, pending: null, seq: 0, len: null };
    setNav({ back: false, fwd: false });
    setLoaded(false);
    setGen((g) => g + 1);
  }, [ready, post]);

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

  // Esc closes the panel — unless a pick is in flight, in which case it calls
  // that off first and the panel stays. (Esc pressed with focus inside the
  // frame never reaches here; the bridge cancels there and tells us.)
  // data-esc-layer (below) makes the chat page's "Esc cancels the running turn"
  // shortcut stand down while we're mounted — same contract as Overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (picking) {
        setPicking(false);
        post({ type: 'pick', on: false });
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, picking, post]);

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
      {/* h-12 matches the chat header exactly — on lg+ the two sit on one line
          and the border-b runs straight across the split. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {/* Read left to right like any browser: where you can go, where you are,
            what you can do to it. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderButton title={ready ? '后退' : NO_BRIDGE} disabled={!nav.back} onClick={() => go(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </HeaderButton>
          <HeaderButton title={ready ? '前进' : NO_BRIDGE} disabled={!nav.fwd} onClick={() => go(1)}>
            <ChevronRight className="h-4 w-4" />
          </HeaderButton>
          <HeaderButton title="刷新预览" onClick={refresh}>
            <RotateCw className="h-3.5 w-3.5" />
          </HeaderButton>
        </div>
        {/* live dot + mode, the house status idiom: a dot and a tracked label,
            never a colored pill. emerald = the registration is live. The mode
            word is the first thing to go when the header runs out of room. */}
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="hidden shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70 sm:inline">
          {preview.mode === 'static' ? 'static' : 'service'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={preview.target}>
          {shortTarget}
        </span>
        {/* Where inside the preview we are. Its own span, brighter than the
            target: after a back button exists, "which page" is the part that
            changes, and it must not be the first thing truncated away. */}
        {here && (
          <span className="max-w-[45%] shrink truncate font-mono text-[11px] text-foreground/70 animate-in fade-in-0" title={here}>
            {here}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderButton
            title={!ready ? NO_BRIDGE : picking ? '取消选择 (Esc)' : '选择页面元素 —— 选中后把它的 CSS 选择器填进输入框'}
            disabled={!ready}
            className={picking ? 'bg-accent/60 text-foreground hover:bg-accent/60' : undefined}
            onClick={togglePick}
          >
            <SquareDashedMousePointer className="h-3.5 w-3.5" />
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
          ref={frameRef}
          src={preview.url}
          title="live preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          className={cn('h-full w-full border-0 bg-white', dragging && 'pointer-events-none')}
          onLoad={() => {
            setLoaded(true);
            // The bridge announces itself unprompted; this only matters for a
            // restore out of the back/forward cache, where the script does not
            // re-run. Costs one message.
            post({ type: 'hello' });
          }}
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
        {/* Picking swallows every click in the frame, which is alarming if you
            have forgotten why. One line, floated clear of the content, saying
            what will happen and how to stop. */}
        {(picking || picked) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
            <span className="max-w-full truncate rounded-full bg-foreground/90 px-3 py-1 text-[11px] font-medium text-background shadow-lg animate-in fade-in-0">
              {picking ? (
                '点选一个元素，选择器会填进输入框 · Esc 取消'
              ) : (
                <>
                  已填进输入框 <span className="font-mono">{picked}</span>
                </>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
