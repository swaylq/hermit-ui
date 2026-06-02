'use client';

// Full-page xterm.js terminal that attaches to a chat session's tmux pane
// via a WS bridge (browser → dashboard custom server → gateway control WS →
// node-pty → `tmux attach -t hermit-<sessionId.slice(-12)>`).
//
// Auth: the WS upgrade carries the dashboard key in the Sec-WebSocket-Protocol
// header as `hermit-key.<token>` (kept out of the URL so it doesn't end up
// in proxy access logs). The server validates key→machine ownership and
// scopes the pane to the session.

import { Suspense, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ArrowLeft } from 'lucide-react';

// xterm.js pulls in DOM-only modules + ~250KB JS; lazy-load so the rest of
// the dashboard doesn't pay for it. Re-export as a single dynamic-imported
// client component.
const TerminalView = dynamic(() => import('./terminal-view').then((m) => m.TerminalView), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
      loading terminal…
    </div>
  ),
});

export default function TerminalPage() {
  return (
    <Suspense fallback={null}>
      <TerminalPageInner />
    </Suspense>
  );
}

function TerminalPageInner() {
  const search = useSearchParams();
  const router = useRouter();
  const sessionId = search.get('session') ?? '';

  const backHref = sessionId ? `/chat?session=${encodeURIComponent(sessionId)}` : '/chat';

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        Missing ?session=… parameter.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-black text-zinc-100">
      <header className="h-10 px-3 flex items-center justify-between gap-3 bg-zinc-950 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => router.push(backHref)}
            aria-label="back to chat"
            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="font-mono text-[11px] text-zinc-400 truncate">
            tmux <span className="text-zinc-200">hermit-{sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12)}</span>
          </span>
        </div>
      </header>
      <TerminalView sessionId={sessionId} />
      <TerminalKeyBar />
    </div>
  );
}

// Touch-friendly key bar pinned to the bottom. Gives mobile — where the soft
// keyboard has no arrow / control keys — and desktop the keys needed to drive
// claude's TUI: Esc, Ctrl-C, Tab, and ↑/↓ + PgUp/PgDn (which also scroll tmux's
// history while in mouse/copy mode). Keystrokes are injected into the xterm via
// the `hermit-term-input` custom event (see terminal-view).
function TerminalKeyBar() {
  const fire = useCallback((data: string) => {
    window.dispatchEvent(new CustomEvent('hermit-term-input', { detail: { data } }));
  }, []);
  return (
    <div className="shrink-0 flex items-center gap-1 overflow-x-auto bg-zinc-950 border-t border-zinc-800 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <QuickKey label="Esc" onClick={() => fire('\x1b')} />
      <QuickKey label="^C" onClick={() => fire('\x03')} title="Ctrl-C (interrupt)" />
      <QuickKey label="Tab" onClick={() => fire('\t')} />
      <span className="mx-0.5 h-5 w-px shrink-0 bg-zinc-700" />
      <QuickKey label="↑" onClick={() => fire('\x1b[A')} title="arrow up" />
      <QuickKey label="↓" onClick={() => fire('\x1b[B')} title="arrow down" />
      <QuickKey label="PgUp" onClick={() => fire('\x1b[5~')} title="page up / scroll up" />
      <QuickKey label="PgDn" onClick={() => fire('\x1b[6~')} title="page down / scroll down" />
      <span className="ml-auto hidden shrink-0 pr-1 font-mono text-[10px] text-zinc-600 sm:inline">live tmux pane · scroll with the wheel</span>
    </div>
  );
}

function QuickKey({ label, onClick, title }: { label: string; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Don't steal focus from the terminal on tap — keeps the mobile soft
      // keyboard up and typing flowing after pressing a key.
      onPointerDown={(e) => e.preventDefault()}
      title={title ?? label}
      className="font-mono text-xs px-3 h-8 min-w-[2.5rem] shrink-0 rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 active:bg-zinc-700 cursor-pointer transition-colors"
    >
      {label}
    </button>
  );
}
