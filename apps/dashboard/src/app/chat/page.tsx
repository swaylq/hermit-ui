'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo, type ChangeEvent, type ClipboardEvent, type DragEvent, Suspense } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, ArrowUp, FileText, RotateCw, Trash2, Check, X, Terminal, Pencil, ChevronDown, ListCollapse, Search, ChevronUp, FoldVertical, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Markdown } from '@/components/markdown';
import { ImageLightbox } from '@/components/ui/image-lightbox';
import { CtxBar } from '@/components/ctx-bar';
import { sessionStatusView } from '@/lib/session-status';
import { markSessionRead } from '@/lib/session-read';
import { getStoredKey } from '@/app/providers';
import { SidebarMobileToggle } from '@/components/app-sidebar';

type Block = { type: string; text?: string; name?: string; input?: any; tool_use_id?: string; content?: any; source?: any; width?: number; height?: number };

// In-flight or finished upload attached to the composer (image or generic file).
// `previewUrl` is an object-URL thumbnail for images, null for non-image files.
type Attachment =
  | { id: string; kind: 'uploading'; name: string; isImage: boolean; previewUrl: string | null }
  | { id: string; kind: 'ready'; name: string; isImage: boolean; previewUrl: string | null; data: { url: string; mimeType: string; width: number | null; height: number | null } }
  | { id: string; kind: 'error'; name: string; error: string };

function ymdLocal(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
}
function isSameDay(a: Date | string, b: Date | string): boolean {
  const x = typeof a === 'string' ? new Date(a) : a;
  const y = typeof b === 'string' ? new Date(b) : b;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// Touch-primary device (phone/tablet): the soft-keyboard return key should
// insert a newline, not send — there's a dedicated send button. Desktop (a
// fine pointer ⇒ physical keyboard) keeps Enter-to-send / Shift+Enter-newline.
// `(pointer: coarse)` reflects the PRIMARY pointer, so a touchscreen laptop
// with a trackpad still reads as fine (desktop behaviour).
function isTouchPrimary(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

// Initial message window: the newest N messages loaded on open. Kept small so a
// session opens fast — less JSON over the wire + far fewer markdown/highlight
// passes on first paint — since the visible viewport is only ~15-20 messages.
// MUST match the sidebar's `listMessages` prefetch limit (app-sidebar.tsx) so a
// session click stays a cache hit. "load earlier" grows the window by PAGE_STEP.
const INITIAL_WINDOW = 60;
const PAGE_STEP = 200;

// useLayoutEffect on the client (runs before the browser paints — used to restore
// scroll position synchronously after a history prepend so there's no visible
// lurch), plain useEffect on the server to dodge React's SSR warning.
const useIsoLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

// ── SSE message-list merge ──────────────────────────────────────────────────
// The stream pushes the entire newest-N window every ~250ms. Writing it into
// the cache wholesale gives every row a fresh object reference (rows come from
// JSON.parse), so memoized MessageRows can't bail and the whole transcript
// re-renders (markdown re-parse + highlight.js) ~4×/sec. Merge by id instead:
// reuse the previous object for any row whose content is unchanged, so only the
// genuinely-changed tail row gets a new reference. With memo(MessageRow) this
// collapses a streaming tick to a single row render. The per-row signature is
// cached on the (immutable) row object, so a reused row is never re-stringified
// — steady-state cost is one JSON.stringify per *changed* row, not per row.
const rowSigCache = new WeakMap<object, string>();
function rowSig(m: { content: unknown }): string {
  let s = rowSigCache.get(m);
  if (s === undefined) {
    s = JSON.stringify(m.content);
    rowSigCache.set(m, s);
  }
  return s;
}
type CachedMsg = { id: string; role: string; content: unknown; createdAt: Date | string };
// Flatten a message's content blocks to plain text — used to match an optimistic
// outbound row against its real counterpart once that lands in the query cache.
function msgText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('').trim();
}

function mergeMessagesById<T extends CachedMsg>(prev: T[] | undefined, next: T[]): T[] {
  if (!prev || prev.length === 0) return next;
  const byId = new Map(prev.map((m) => [m.id, m]));
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const old = byId.get(n.id);
    if (old && old.role === n.role && rowSig(old) === rowSig(n)) {
      if (old !== prev[i]) changed = true; // same row, new position
      return old;
    }
    changed = true;
    return n;
  });
  // Nothing moved or changed → hand back the previous array so its reference is
  // stable too, letting memo(MessageTimeline) bail on a no-op keepalive tick.
  return changed ? out : prev;
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const search = useSearchParams();
  const router = useRouter();
  const sessionParam = search.get('session');
  const agentParam = search.get('agent');
  const showNew = !!search.get('new') || (!!agentParam && !sessionParam);

  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000 });
  // No own refetchInterval — the always-mounted sidebar already polls
  // listSessions every 5s; this shares that cache (used here only for the
  // landing redirect + empty state). Drops a duplicate 5s poll/re-render.
  const sessions = trpc.chat.listSessions.useQuery({});

  // Selection is URL-driven (?session=<id>); the global app sidebar owns the
  // session list + New chat. When nothing is selected and we're not composing a
  // new chat, land on the most recent session so the area is never blank.
  useEffect(() => {
    if (showNew || sessionParam) return;
    const first = sessions.data?.[0];
    if (first) router.replace(`/chat?session=${encodeURIComponent(first.id)}`);
  }, [showNew, sessionParam, sessions.data, router]);

  if (showNew) {
    return (
      <NewChatPane
        agents={(agents.data ?? []).map((a) => a.name)}
        preset={agentParam ?? undefined}
        // Land on the freshly-created session via a hard navigation. A
        // programmatic router.replace()/push() does NOT reliably navigate here
        // (Next 16 + custom server): createSession makes the row but the view
        // stays stuck on the form — confirmed live whether the call sits in the
        // mutation onSuccess callback OR a downstream effect. window.location is
        // browser-native and can't be swallowed; the reload is fine for a
        // deliberate "start chat" and lands cleanly on the new session.
        onCreated={(id) => { window.location.href = `/chat?session=${encodeURIComponent(id)}`; }}
        // Same Next16 swallow as onCreated: router.replace to a same-path query
        // REMOVAL (/chat?new=1 → /chat) silently no-ops, so the cancel button did
        // nothing. window.location is browser-native and can't be swallowed.
        onCancel={() => { window.location.href = sessionParam ? `/chat?session=${encodeURIComponent(sessionParam)}` : '/chat'; }}
      />
    );
  }

  if (sessionParam) {
    // key remounts SessionPane on session switch — resets scroll + streaming
    // refs cleanly (no carry-over between sessions).
    return <SessionPane key={sessionParam} sessionId={sessionParam} />;
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0 lg:hidden">
        <SidebarMobileToggle />
      </header>
      <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
        {sessions.isPending ? 'loading…' : 'No chats yet — start a New chat from the sidebar.'}
      </div>
    </div>
  );
}

function NewChatPane({ agents, preset, onCreated, onCancel }: { agents: string[]; preset?: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [agent, setAgent] = useState('');
  useEffect(() => {
    setAgent((cur) => cur || (preset && agents.includes(preset) ? preset : agents[0] ?? ''));
  }, [preset, agents]);
  const create = trpc.chat.createSession.useMutation({ onSuccess: (s) => onCreated(s.id) });
  return (
    <div className="flex flex-1 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">New chat</span>
      </header>
      <div className="flex-1 flex items-center justify-center p-6">
        <form
          className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm"
          onSubmit={(e) => { e.preventDefault(); if (agent) create.mutate({ agentName: agent }); }}
        >
          <div className="text-center space-y-2">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
              <Plus className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">Start a new chat</h2>
            <p className="text-xs text-muted-foreground">Pick an agent to talk to.</p>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Agent</span>
            <Select value={agent} onValueChange={(v) => setAgent(v ?? '')} modal={false}>
              <SelectTrigger aria-label="select agent" className="mt-1.5 w-full py-2 text-sm font-mono">
                <SelectValue>{(v: string | null) => (v ? v : (agents.length ? 'Pick an agent' : 'no agents found'))}</SelectValue>
              </SelectTrigger>
              <SelectContent className="font-mono">
                {agents.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={!agent || create.isPending} className="flex-1 h-10">
              {create.isPending ? 'creating…' : 'Start chat'}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={onCancel}>cancel</Button>
          </div>
          {create.error && <p className="text-xs text-rose-500">{create.error.message}</p>}
        </form>
      </div>
    </div>
  );
}

// Icon button with an inline two-step confirm (click → ✓ confirm / ✗ cancel),
// auto-disarming after a few seconds. Used for destructive/disruptive session
// actions (restart, delete) per "删除/restart 前都需要确认".
function ConfirmIconButton({
  icon: Icon,
  title,
  onConfirm,
  disabled = false,
  busy = false,
  danger = false,
}: {
  icon: LucideIcon;
  title: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);

  if (armed) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background px-0.5">
        <button
          type="button"
          onClick={() => { setArmed(false); onConfirm(); }}
          className={cn(
            'inline-flex items-center gap-1 h-7 px-1.5 rounded text-xs font-medium cursor-pointer transition-colors',
            danger ? 'text-rose-600 hover:bg-rose-500/10' : 'text-foreground hover:bg-accent',
          )}
        >
          <Check className="h-3.5 w-3.5" /> confirm
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          title="cancel"
          aria-label="cancel"
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:bg-accent cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      disabled={disabled || busy}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        danger ? 'hover:bg-rose-500/10 hover:text-rose-600' : 'hover:bg-accent hover:text-foreground',
      )}
    >
      {busy ? <span className="text-xs">…</span> : <Icon className="h-4 w-4" />}
    </button>
  );
}

// ── Summary mode ─────────────────────────────────────────────────────────────
// A global, persisted "reading mode" that collapses each agent turn down to its
// final text reply — hiding tool calls, results, thinking, and intermediate
// prose. Persisted in localStorage so it sticks across sessions and reloads.
function useSummaryMode(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try { setOn(localStorage.getItem('hermit:chat-summary') === '1'); } catch {}
  }, []);
  const toggle = useCallback(() => {
    setOn((v) => {
      const n = !v;
      try { localStorage.setItem('hermit:chat-summary', n ? '1' : '0'); } catch {}
      return n;
    });
  }, []);
  return [on, toggle];
}

type TimelineMsg = { id: string; role: string; content: any; createdAt: Date | string };

// Collapse the timeline to "only the agent's final summary per turn". A turn runs
// from one human-user message to the next; within it we keep the trailing run of
// assistant text rows that come AFTER the turn's last tool activity (the final
// answer), or — for a turn with no tools — all its text rows. Human-user and
// system rows (prompts, restart/interaction notices) are always kept so the
// conversation still reads as Q→A.
function toSummaryView(messages: TimelineMsg[]): TimelineMsg[] {
  const isToolResultOnly = (c: any) =>
    Array.isArray(c) && c.length > 0 && c.every((b: any) => b?.type === 'tool_result');
  const hasText = (c: any) =>
    Array.isArray(c) && c.some((b: any) => b?.type === 'text' && (b.text ?? '').trim());
  const out: TimelineMsg[] = [];
  let turn: TimelineMsg[] = [];
  const flush = () => {
    if (turn.length === 0) return;
    let lastTool = -1;
    turn.forEach((m, idx) => {
      const c = m.content;
      if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_use' || b?.type === 'tool_result')) lastTool = idx;
    });
    turn.forEach((m, idx) => {
      if (idx <= lastTool) return;
      if (m.role === 'assistant' && hasText(m.content) && !isHarnessTerminator(m.content)) out.push(m);
    });
    turn = [];
  };
  for (const m of messages) {
    const humanUser = m.role === 'user' && hasText(m.content) && !isToolResultOnly(m.content);
    if (humanUser) { flush(); out.push(m); continue; }
    if (m.role === 'system') { flush(); out.push(m); continue; }
    turn.push(m); // assistant + tool-result rows accumulate into the current turn
  }
  flush();
  return out;
}

// ── Composer draft persistence ──────────────────────────────────────────────
// Keep unsent text per session in localStorage so switching away and back
// (SessionPane remounts on session change) doesn't lose what you typed. Cleared
// on send / Escape (setDraft('') → the save effect removes the key).
const draftKey = (sid: string) => `hermit:draft:${sid}`;
function loadDraft(sid: string): string {
  try { return localStorage.getItem(draftKey(sid)) ?? ''; } catch { return ''; }
}
function saveDraft(sid: string, v: string) {
  try { if (v) localStorage.setItem(draftKey(sid), v); else localStorage.removeItem(draftKey(sid)); } catch {}
}

// ── In-chat find ─────────────────────────────────────────────────────────────
// Cmd/Ctrl+F search scoped to the OPEN session. Matches are computed over the
// rendered text in the scroll viewport — so it finds exactly what you see (full
// or summary view, the loaded window) — and painted with the CSS Custom
// Highlight API (overlay Ranges, no DOM mutation, survives React re-renders).
// ↑/↓ or Enter / Shift+Enter step matches; Esc closes.
const HL_CTOR: any = typeof window !== 'undefined' ? (window as any).Highlight : undefined;
const HL_REG: any = typeof CSS !== 'undefined' ? (CSS as any).highlights : undefined;
const HL_OK = !!HL_CTOR && !!HL_REG;

function ChatFind({ getViewport, onClose }: { getViewport: () => HTMLElement | null; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [pos, setPos] = useState(0); // 1-based current match (0 = none)
  const rangesRef = useRef<Range[]>([]);
  const posRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const paint = useCallback((idx0: number) => {
    if (!HL_OK) return;
    const ranges = rangesRef.current;
    HL_REG.set('chat-find', new HL_CTOR(...ranges));
    const cur = ranges[idx0];
    if (cur) HL_REG.set('chat-find-current', new HL_CTOR(cur));
    else HL_REG.delete('chat-find-current');
  }, []);

  const clearHl = useCallback(() => {
    if (HL_OK) { HL_REG.delete('chat-find'); HL_REG.delete('chat-find-current'); }
    rangesRef.current = [];
  }, []);

  const scrollToCurrent = useCallback(() => {
    const root = getViewport();
    const r = rangesRef.current[posRef.current - 1];
    if (!root || !r) return;
    const rect = r.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // detached / not laid out
    const vp = root.getBoundingClientRect();
    root.scrollTop += rect.top - vp.top - vp.height / 2 + rect.height / 2;
  }, [getViewport]);

  const recompute = useCallback((scroll: boolean) => {
    const root = getViewport();
    const q = query.trim().toLowerCase();
    if (!root || !q) { clearHl(); setCount(0); setPos(0); posRef.current = 0; return; }
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const hay = node.nodeValue!.toLowerCase();
      let i = hay.indexOf(q);
      while (i !== -1) {
        try {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + q.length);
          ranges.push(r);
        } catch { /* node went stale mid-walk — skip */ }
        i = hay.indexOf(q, i + q.length);
      }
    }
    rangesRef.current = ranges;
    setCount(ranges.length);
    if (ranges.length === 0) { clearHl(); rangesRef.current = []; setPos(0); posRef.current = 0; return; }
    let next = posRef.current;
    if (next < 1 || next > ranges.length) next = 1;
    posRef.current = next;
    setPos(next);
    paint(next - 1);
    if (scroll) scrollToCurrent();
  }, [query, getViewport, clearHl, paint, scrollToCurrent]);

  // New query → jump to the first match.
  useEffect(() => {
    posRef.current = 1;
    const t = setTimeout(() => recompute(true), 120);
    return () => clearTimeout(t);
  }, [query, recompute]);

  // Rendered content changed (streaming / load-earlier / summary toggle) →
  // re-paint and keep the user's position; don't scroll. (Painting via the
  // Highlight API doesn't mutate the DOM, so this never self-triggers.)
  useEffect(() => {
    const root = getViewport();
    if (!root) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const mo = new MutationObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => recompute(false), 200);
    });
    mo.observe(root, { childList: true, characterData: true, subtree: true });
    return () => { mo.disconnect(); if (t) clearTimeout(t); };
  }, [getViewport, recompute]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => () => clearHl(), [clearHl]); // clear highlights on close

  const step = useCallback((delta: number) => {
    const n = rangesRef.current.length;
    if (n === 0) return;
    let next = posRef.current + delta;
    if (next < 1) next = n;
    if (next > n) next = 1;
    posRef.current = next;
    setPos(next);
    paint(next - 1);
    scrollToCurrent();
  }, [paint, scrollToCurrent]);

  const navBtn = 'inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-default cursor-pointer';
  return (
    <div className="border-b border-border bg-background px-3 h-11 flex items-center gap-2 shrink-0">
      <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        placeholder="在本会话中查找…"
        aria-label="find in conversation"
        className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-muted-foreground/60"
      />
      <span className="shrink-0 w-12 text-right text-xs font-mono tabular-nums text-muted-foreground">
        {query.trim() ? `${pos}/${count}` : ''}
      </span>
      <button type="button" className={navBtn} onClick={() => step(-1)} disabled={count === 0} aria-label="previous match" title="上一个 · Shift+Enter">
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" className={navBtn} onClick={() => step(1)} disabled={count === 0} aria-label="next match" title="下一个 · Enter">
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" className={navBtn} onClick={onClose} aria-label="close find" title="关闭 · Esc">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function SessionPane({ sessionId }: { sessionId: string }) {
  const utils = trpc.useUtils();
  const sessionMeta = trpc.chat.listSessions.useQuery({});
  const session = sessionMeta.data?.find((s) => s.id === sessionId);
  // Live updates arrive via SSE (/api/chat/stream), written straight into this
  // query's cache. The poll below is only a fallback for when the stream isn't
  // connected (the gateway flushes block-level rows into Postgres either way).
  const [streamConnected, setStreamConnected] = useState(false);
  // Newest-N window; starts at INITIAL_WINDOW, grows by PAGE_STEP per "load
  // earlier". Resets on
  // session switch (SessionPane is keyed by sessionId, so this state remounts).
  const [limit, setLimit] = useState(INITIAL_WINDOW);
  const [summaryMode, toggleSummary] = useSummaryMode();
  const [findOpen, setFindOpen] = useState(false);
  const messages = trpc.chat.listMessages.useQuery(
    { sessionId, limit },
    {
      // Fallback poll when SSE is down: 600ms during an active turn, 2s idle.
      refetchInterval: (q) => {
        if (streamConnected) return false;
        const last = q.state.data?.[q.state.data.length - 1];
        if (!last) return 2_000;
        if (last.role === 'user') return 600;
        const ageMs = Date.now() - new Date(last.createdAt).getTime();
        if (ageMs < 3_000) return 600;
        return 2_000;
      },
      // Revisiting a session within 1 min skips the network roundtrip entirely
      // (cache is considered fresh). Combined with the sidebar prefetch in
      // ChatPageInner, virtually every session click is a cache hit — no
      // Skeleton flash, no waiting. `refetchInterval` still drives background
      // updates while the user is looking at the session.
      staleTime: 60_000,
      // Keep the current window visible while a larger one loads after "load
      // earlier" — no Skeleton wipe of the whole conversation on key change.
      placeholderData: keepPreviousData,
    },
  );

  // ── Live updates via Server-Sent Events ──────────────────────────────────
  // Stream the message list as it changes and write each push into the query
  // cache, so all downstream logic (streaming detection, scroll, typewriter)
  // keeps reading `messages.data` unchanged. fetch()+ReadableStream (not
  // EventSource) so we can send the x-asst-key header. Falls back to the poll
  // above if the stream drops.
  useEffect(() => {
    let ctrl: AbortController | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled || document.hidden || ctrl) return; // hidden, or already streaming
      const myCtrl = new AbortController();
      ctrl = myCtrl;
      (async () => {
        try {
          const res = await fetch(`/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`, {
            headers: { 'x-asst-key': getStoredKey() },
            signal: myCtrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          setStreamConnected(true);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            buf += dec.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
              if (!dataLine) continue;
              try {
                const rows = JSON.parse(dataLine.slice(5).trim());
                utils.chat.listMessages.setData({ sessionId, limit }, (prev) => mergeMessagesById(prev, rows));
              } catch { /* ignore a malformed frame */ }
            }
          }
        } catch {
          /* network error or abort — the fallback poll takes over */
        } finally {
          if (ctrl === myCtrl) ctrl = null;
          if (!cancelled) setStreamConnected(false);
        }
      })();
    };

    const disconnect = () => {
      const c = ctrl;
      ctrl = null;
      c?.abort();
      setStreamConnected(false);
    };

    // Pause the stream while the tab is hidden: otherwise a backgrounded chat
    // keeps the server polling Postgres every POLL_MS indefinitely. Reopen on
    // return. (The fallback listMessages poll is already paused in the
    // background by react-query's refetchIntervalInBackground:false default.)
    const onVisibility = () => { if (document.hidden) disconnect(); else connect(); };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      ctrl?.abort();
      setStreamConnected(false);
    };
  }, [sessionId, limit, utils]);

  const send = trpc.chat.send.useMutation({
    onSuccess: () => {
      utils.chat.listMessages.invalidate({ sessionId });
      utils.chat.listSessions.invalidate();
    },
  });
  const cancelTurn = trpc.chat.cancelTurn.useMutation({
    onSuccess: () => {
      utils.chat.listMessages.invalidate({ sessionId });
    },
  });
  const router = useRouter();
  // Hard navigation after delete: programmatic router.push()/replace() is
  // unreliable in this Next 16 + custom-server setup (see ChatPageInner's
  // onCreated note), so leaving the now-deleted session via the router can
  // strand the user on a dead URL. window.location reloads to /chat, where the
  // landing effect picks the most-recent session.
  const deleteSession = trpc.chat.deleteSession.useMutation({
    onSuccess: () => { window.location.href = '/chat'; },
  });
  const restartSession = trpc.chat.requestSessionRestart.useMutation({
    onSuccess: () => sessionMeta.refetch(),
  });

  const [draft, setDraft] = useState(() => loadDraft(sessionId));
  // Persist the draft per session (localStorage writes are cheap for short
  // text). Auto-cleared when the draft empties on send / Escape.
  useEffect(() => { saveDraft(sessionId, draft); }, [sessionId, draft]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Optimistic outbound messages — render the user's bubble instantly on send so
  // it doesn't wait for the send round-trip + SSE echo (~200ms). Kept in a SEPARATE
  // overlay (NOT the query cache): the SSE rewrites the cache via
  // mergeMessagesById(prev,next) => next, which would drop an in-cache optimistic
  // row on the next stream push (and flicker it mid-turn). Merged into `view` at
  // render-time and auto-dropped once the real row (same text) lands in the cache.
  const [pending, setPending] = useState<Array<{ id: string; role: 'user'; content: { type: 'text'; text: string }[]; createdAt: string }>>([]);
  // Armed when the user clicks Restart on a dead session — reveals the composer
  // again so their next message respawns claude (--resume). Reset on session
  // switch (SessionPane is keyed by sessionId).
  const [restartArmed, setRestartArmed] = useState(false);
  // Inline-edit the session title from the header. Clicking the title swaps
  // it for an input; Enter or blur saves, Escape cancels. Backend already has
  // `chat.setTitle` — we just plug into it.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const setTitleMut = trpc.chat.setTitle.useMutation({
    onSuccess: () => { sessionMeta.refetch(); setEditingTitle(false); },
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Track whether the messages viewport is pinned to the bottom. We only
  // auto-scroll when the user is already there — otherwise reading older
  // messages while the assistant streams would yank scroll position.
  // The "scroll to bottom" pill below the messages reveals itself whenever
  // `pinnedToBottom` is false.
  const [pinnedToBottom, setPinnedToBottomState] = useState(true);
  // pinnedRef mirrors pinnedToBottom so the ResizeObserver / scroll listener can
  // read the latest value without re-subscribing; setPinned keeps both in sync.
  const pinnedRef = useRef(true);
  const setPinned = useCallback((v: boolean) => { pinnedRef.current = v; setPinnedToBottomState(v); }, []);
  // True while WE scroll programmatically, so the scroll listener doesn't misread
  // the in-between position and unpin the user mid-follow.
  const autoScrollRef = useRef(false);
  // Treat the very first paint as a "scroll to bottom" regardless of position.
  const firstScrollRef = useRef(true);

  const getViewport = useCallback((): HTMLElement | null => {
    return scrollRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = getViewport();
    if (!el) return;
    autoScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setPinned(true);
    requestAnimationFrame(() => { autoScrollRef.current = false; });
  }, [getViewport, setPinned]);

  // "load earlier" grows the window from the top. Capture pre-grow scroll
  // metrics so we can restore the same top-anchor once the taller list paints —
  // otherwise the prepended history shoves the viewport down and yanks the user.
  const pendingRestoreRef = useRef<{ h: number; t: number } | null>(null);
  const loadEarlier = useCallback(() => {
    const el = getViewport();
    if (el) pendingRestoreRef.current = { h: el.scrollHeight, t: el.scrollTop };
    setLimit((l) => l + PAGE_STEP);
  }, [getViewport]);

  // Eligibility for an infinite-scroll-up pull. Held in a ref so the scroll
  // listener reads the latest value without re-subscribing every render.
  const canLoadEarlierRef = useRef(false);
  canLoadEarlierRef.current = (messages.data?.length ?? 0) >= limit && !messages.isFetching;

  // The rendered timeline. Summary mode collapses each turn to its final reply;
  // useMemo keeps the array reference stable between refetches so memo(MessageTimeline) still bails on no-op ticks.
  const view = useMemo(() => {
    const base = summaryMode ? toSummaryView(messages.data ?? []) : (messages.data ?? []);
    if (pending.length === 0) return base;
    // Drop any optimistic row whose real counterpart (same user text) has landed.
    const sent = new Set((messages.data ?? []).filter((m) => m.role === 'user').map((m) => msgText(m.content)));
    const live = pending.filter((p) => !sent.has(msgText(p.content)));
    return live.length ? [...base, ...live] : base;
  }, [messages.data, summaryMode, pending]);

  // Prune optimistic rows once reflected in the cache so `pending` doesn't grow
  // over a long session. Same-ref return guards against a render loop.
  useEffect(() => {
    if (pending.length === 0) return;
    const sent = new Set((messages.data ?? []).filter((m) => m.role === 'user').map((m) => msgText(m.content)));
    setPending((p) => {
      const next = p.filter((x) => !sent.has(msgText(x.content)));
      return next.length === p.length ? p : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.data]);

  // Sticky bottom. A ResizeObserver on the message content follows EVERY height
  // change to the bottom while pinned — new messages, streaming growth, and
  // images / code-highlight that finish laying out asynchronously (which a data-
  // or length-only signal both miss, leaving the view above the true bottom).
  // The autoScroll guard stops our own scroll from unpinning the user; if they
  // scroll up to read history, pinnedRef goes false and we leave them alone.
  // Skipped while a "load earlier" prepend is being anchored.
  useEffect(() => {
    const el = getViewport();
    if (!el) return;
    const content = el.firstElementChild as HTMLElement | null;
    if (!content) return;
    const toBottom = () => {
      autoScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { autoScrollRef.current = false; });
    };
    if (firstScrollRef.current) { firstScrollRef.current = false; toBottom(); }
    const ro = new ResizeObserver(() => {
      if (pendingRestoreRef.current) return;   // top prepend (load earlier), not tail growth
      if (pinnedRef.current) toBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [getViewport]);

  // Restore the top-anchor after a "load earlier" prepend (guarded by the ref,
  // so streaming-driven length changes don't trigger it). The bottom-pin effect
  // above no-ops here because the user isn't pinned when loading history.
  useIsoLayoutEffect(() => {
    const p = pendingRestoreRef.current;
    if (!p) return;
    pendingRestoreRef.current = null;
    const el = getViewport();
    if (el) el.scrollTop = el.scrollHeight - p.h + p.t;
  }, [messages.data?.length, getViewport]);

  // Track the user's scroll intent. Ignore scrolls WE triggered (autoScrollRef)
  // so an auto-follow never unpins them; a real upward scroll past the slack
  // unpins (and reveals the "scroll to bottom" pill). ~60px slack tolerates
  // small async layout shifts without unpinning.
  useEffect(() => {
    const el = getViewport();
    if (!el) return;
    const onScroll = () => {
      if (autoScrollRef.current) return;
      setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      // Infinite scroll up: near the top, pull the next page of history. Clear
      // the debounce flag here (recomputed next render) so one fling fires once;
      // loadEarlier anchors the scroll so the prepend doesn't yank the viewport.
      if (el.scrollTop < 200 && canLoadEarlierRef.current && !pendingRestoreRef.current) {
        canLoadEarlierRef.current = false;
        loadEarlier();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [getViewport, setPinned, loadEarlier]);

  // Hard initial scroll-to-bottom, fired ONCE when messages first land for this
  // session (keyed remount resets the guard). The RO+pinned chain above follows
  // ongoing growth, but the *initial* anchor is fragile on open: firstScrollRef
  // can be consumed while the list is still empty/pending, and async markdown /
  // image layout (or browser scroll-anchoring) can fire a scroll that unpins
  // before the RO catches up — leaving a fresh conversation stuck at the top.
  // We force the bottom on the first non-empty render, then re-assert across a
  // few frames to outlast late layout. Retries respect pinnedRef, so a user who
  // scrolls up within the first 500ms isn't yanked back down.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (!messages.data || messages.data.length === 0) return;
    didInitialScrollRef.current = true;
    const el = getViewport();
    if (!el) return;
    const pin = (force: boolean) => {
      if (!force && !pinnedRef.current) return;
      autoScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      if (force) setPinned(true);
      requestAnimationFrame(() => { autoScrollRef.current = false; });
    };
    pin(true);
    const timers = [60, 200, 500].map((ms) => setTimeout(() => pin(false), ms));
    return () => timers.forEach(clearTimeout);
  }, [messages.data, getViewport, setPinned]);

  // Optimistic "awaiting reply" — the newest loaded message is a user row with no
  // assistant answer yet, so we can show "working" the instant you send (before the
  // ~15s gateway snapshot). It MUST reconcile, though: a dropped/errored turn (no
  // assistant row ever lands) would otherwise pin "working" forever, which also
  // disables the composer (canSend needs !inFlight) and makes Stop a no-op (Escape
  // on an idle pane does nothing; cancel writes no row to flip this off). So clear
  // it once the gateway has actually observed the pane idle after this message —
  // either a snapshot taken past the message, or a grace backstop if snapshots
  // stall. A genuinely running turn keeps state==='working', so a real turn is
  // never cut short.
  const lastMsg = messages.data?.[messages.data.length - 1];
  const lastMsgIsUser = lastMsg?.role === 'user';
  const lastMsgTime = lastMsg ? new Date(lastMsg.createdAt).getTime() : 0;
  const snapTime = session?.snapshotAt ? new Date(session.snapshotAt).getTime() : 0;
  const turnSettled =
    session?.state === 'idle' && (snapTime > lastMsgTime || Date.now() - lastMsgTime > 90_000);
  const isWaitingAssistant = lastMsgIsUser && !turnSettled;

  // Any unresolved interaction (permission / question) in the loaded window?
  // While one is pending the agent's turn is BLOCKED on the user's click — gate
  // the composer + show "needs you" instead of working/ready.
  const pendingInteraction = useMemo(() => {
    const msgs = messages.data;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const content = msgs[i].content as unknown;
      if (!Array.isArray(content)) continue;
      for (const b of content as Array<Record<string, unknown>>) {
        if (b && b.type === 'interaction' && b.status === 'pending') {
          return { id: String(b.interactionId ?? ''), kind: String(b.kind ?? '') };
        }
      }
    }
    return null;
  }, [messages.data]);

  // Streaming detection: gateway upserts the assistant row by externalId, so a
  // growing bubble is visible as its `content` JSON changing between polls.
  // Treat the row as "still streaming" while it has grown within the last
  // ~1.8s; that window covers the gap between flushes (gateway flushes every
  // 200ms, dashboard polls at 600ms during active turns).
  const lastSigRef = useRef<{ id: string; sig: string; lastGrewAt: number } | null>(null);
  const [streamingTailId, setStreamingTailId] = useState<string | null>(null);
  useEffect(() => {
    const last = messages.data?.[messages.data.length - 1];
    if (!last || last.role !== 'assistant') {
      lastSigRef.current = null;
      setStreamingTailId(null);
      return;
    }
    const sig = JSON.stringify(last.content);
    const prev = lastSigRef.current;
    const firstSight = !prev || prev.id !== last.id;
    if (firstSight) {
      // First time we observe THIS assistant row — true on mount, on session
      // switch (SessionPane is reused without a key, so this ref carries over
      // from the previous session), and when a fresh row actually appears mid
      // turn. Content alone can't tell streaming-just-started from static
      // history being seen for the first time; both look like a new id. Use
      // recency instead: only a row created in the last ~3s is plausibly still
      // streaming (same threshold the refetchInterval uses). Otherwise just
      // record its signature so old history doesn't flash a phantom
      // "working…" indicator when the session is opened.
      const ageMs = Date.now() - new Date(last.createdAt).getTime();
      lastSigRef.current = { id: last.id, sig, lastGrewAt: Date.now() };
      setStreamingTailId(ageMs < 3_000 ? last.id : null);
    } else if (prev.sig !== sig) {
      // Same row, content grew between polls → genuinely streaming.
      lastSigRef.current = { id: last.id, sig, lastGrewAt: Date.now() };
      setStreamingTailId(last.id);
    }
  }, [messages.data]);
  // Tick to clear streamingTailId once the bubble has been quiet for >1.8s.
  useEffect(() => {
    if (!streamingTailId) return;
    const id = setInterval(() => {
      const prev = lastSigRef.current;
      if (!prev || Date.now() - prev.lastGrewAt > 1800) {
        setStreamingTailId(null);
      }
    }, 400);
    return () => clearInterval(id);
  }, [streamingTailId]);

  // ESC while a turn is in flight = click Stop. Lives at the document level
  // since the textarea is disabled during streaming and can't receive keys.
  const isInFlight = isWaitingAssistant || !!streamingTailId;
  // Status badge: gateway's pane-derived state, flipped to "working" instantly
  // off our own in-flight signal. unread=false — we're looking at this session,
  // so it's read by definition (never the red "unread" dot in its own header).
  const status = pendingInteraction
    ? { key: 'needs-you' as const, label: 'needs you', dot: 'bg-amber-400', pulse: true }
    : sessionStatusView(session, { liveWorking: isInFlight, unread: false });

  // The in-dialog "thinking" dots are driven by the SAME status as the header
  // dot, so the two can never disagree. The old code keyed the dots off local
  // SSE signals (isWaitingAssistant / streamingTailId), which settle out of step
  // with the gateway's pane-derived `working` — e.g. a long tool call with no new
  // block for >1.8s cleared the dots while the header still read "working". Show
  // them whenever the session is working OR coming up (starting / restarting).
  const showThinkingDots =
    status.key === 'working' || status.key === 'starting' || status.key === 'restarting';

  // Viewing a session = reading it. Stamp it read on open and on every new
  // message that lands while open, so it never shows the red "unread" dot to the
  // sidebar / agent-detail views once we've seen the latest.
  useEffect(() => {
    markSessionRead(sessionId);
  }, [sessionId, messages.data?.length, isInFlight]);

  // Exited sessions stay usable: sending `--resume`s the dead pane (the gateway
  // respawns on delivery; the backend `send` only blocks closed sessions), so we
  // never swap the composer for the RestartBar — the composer + send revive it,
  // and the explicit restart still lives in the header. (RestartBar + restartArmed
  // are vestigial now; safe to delete in a follow-up.)
  const inactive = false;
  const showRestartBar = inactive && !restartArmed;
  useEffect(() => {
    if (!isInFlight || session?.closedAt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (cancelTurn.isPending) return;
      e.preventDefault();
      cancelTurn.mutate({ sessionId });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isInFlight, session?.closedAt, sessionId, cancelTurn]);

  // Cmd/Ctrl+/ from anywhere on the chat page jumps focus into the composer.
  // Standard ChatGPT-style shortcut for "back to typing" without grabbing
  // browser-native keys like Cmd+L.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || !(e.metaKey || e.ctrlKey)) return;
      const ta = taRef.current;
      if (!ta) return;
      e.preventDefault();
      ta.focus();
      // Land caret at the end so users can immediately continue typing.
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cmd/Ctrl+F opens in-chat find (overrides the browser's native find — like
  // Slack / Notion, an in-app find is more useful here than Ctrl+F over the DOM).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Empty-state chip → fills compose, focuses caret at end, triggers resize.
  const pickPrompt = useCallback((text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
    });
  }, []);

  return (
    <>
      <div className="border-b border-border px-4 h-12 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarMobileToggle />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground leading-tight min-w-0">
              {editingTitle ? (
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      setTitleMut.mutate({ id: sessionId, title: titleDraft.trim() });
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingTitle(false);
                    }
                  }}
                  onBlur={() => {
                    const next = titleDraft.trim();
                    if (next === (session?.title ?? '')) setEditingTitle(false);
                    else setTitleMut.mutate({ id: sessionId, title: next });
                  }}
                  maxLength={120}
                  placeholder={session?.agentName ?? 'session title'}
                  className="min-w-0 flex-1 bg-transparent border-b border-foreground/40 outline-none text-sm font-semibold text-foreground"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(session?.title ?? '');
                    setEditingTitle(true);
                  }}
                  title="click to edit title (Enter saves · Esc cancels)"
                  className="group/title min-w-0 inline-flex items-center gap-1 cursor-text rounded px-1 -mx-1 hover:bg-accent/40 transition-colors text-left"
                >
                  {/* Same label as the sidebar entry (app-sidebar.tsx): title,
                      else first-message preview, else agent name — so the
                      header matches the name you clicked on the left. */}
                  <span className="truncate">{session?.title || session?.preview || session?.agentName || sessionId.slice(0, 8)}</span>
                  <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover/title:opacity-100 transition-opacity text-muted-foreground/70" aria-hidden="true" />
                </button>
              )}
              {/* Status dot — color + pulse track the real Claude Code state */}
              {session && (
                <span
                  className={cn('h-1.5 w-1.5 rounded-full shrink-0', status.dot, status.pulse && 'animate-pulse')}
                  aria-label={status.label}
                />
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground truncate">
              <span className="text-foreground/70">{session?.agentName}</span>
              {session && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{status.label}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <CtxBar tokens={session.contextTokens} />
                </>
              )}
              {session?.closedAt && <><span className="text-muted-foreground/40">·</span><span className="text-muted-foreground">closed</span></>}
            </div>
          </div>
        </div>
        <div className="relative flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setFindOpen((v) => !v)}
            aria-pressed={findOpen}
            aria-label="find in conversation"
            title="在本会话中查找 (⌘F)"
            className={cn(
              'inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors cursor-pointer',
              findOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={toggleSummary}
            aria-pressed={summaryMode}
            aria-label="toggle summary-only view"
            title={summaryMode ? '当前：只看总结回复 — 点击显示完整过程' : '只看 agent 的总结回复，隐藏中间过程（工具调用等）'}
            className={cn(
              'inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors cursor-pointer',
              summaryMode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <ListCollapse className="h-4 w-4" />
          </button>
          <Link
            href={`/chat/terminal?session=${encodeURIComponent(sessionId)}`}
            title="attach to this session's tmux pane"
            aria-label="terminal access"
            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
          >
            <Terminal className="h-4 w-4" />
          </Link>
          <ConfirmIconButton
            icon={FoldVertical}
            title="compact — summarize the conversation so the agent's context window shrinks (runs /compact, keeps continuity). THIS is what reduces a large context; restart only reloads the whole history via --resume."
            disabled={!session || !!session?.closedAt}
            onConfirm={() => send.mutate({ sessionId, text: '/compact', images: [], files: [] })}
          />
          <ConfirmIconButton
            icon={RotateCw}
            title="restart — kill this session's tmux pane; the next message respawns claude with --resume (history preserved; context NOT reduced — use compact ⌄ for that)"
            busy={!!session?.restartRequestedAt || restartSession.isPending}
            disabled={!session}
            onConfirm={() => { restartSession.mutate({ id: sessionId }); setRestartArmed(true); }}
          />
          <ConfirmIconButton
            icon={Trash2}
            danger
            title="delete this session and its messages"
            busy={deleteSession.isPending}
            disabled={!session}
            onConfirm={() => deleteSession.mutate({ id: sessionId })}
          />
        </div>
      </div>

      {findOpen && <ChatFind getViewport={getViewport} onClose={() => setFindOpen(false)} />}

      <ScrollArea ref={scrollRef} className="flex-1 min-h-0 bg-background">
        {/* overflow-x-clip guarantees the conversation never scrolls sideways as
            a whole; wide content (tables, code) scrolls within its own message.
            `clip` (not hidden) avoids forcing overflow-y to auto. */}
        <div className="px-4 py-4 max-w-3xl mx-auto overflow-x-clip [overflow-anchor:none]">
          {messages.isPending ? (
            <Skeleton className="h-32" />
          ) : view.length === 0 ? (
            <EmptyChat agentName={session?.agentName} onPickPrompt={pickPrompt} />
          ) : (
            <>
              {(messages.data?.length ?? 0) >= limit && (
                <div className="flex justify-center pb-3">
                  <button
                    type="button"
                    onClick={loadEarlier}
                    disabled={messages.isFetching}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors cursor-pointer hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 disabled:cursor-wait disabled:opacity-50"
                  >
                    {messages.isFetching ? 'loading…' : '↑ load earlier'}
                  </button>
                </div>
              )}
              {summaryMode && view.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground py-8">
                  只显示总结回复 · 本轮还在进行，暂无最终回复
                </p>
              ) : (
                <MessageTimeline messages={view} streamingTailId={streamingTailId} dotClass={status.dot} />
              )}
            </>
          )}
          {/* Only show the standalone dots-below indicator while the assistant
              has not yet emitted any content. Once the bubble appears, dots
              live inline at the bubble's tail (StreamingDots). */}
          {showThinkingDots && !streamingTailId && <TypingIndicator dot={status.dot} />}
        </div>
      </ScrollArea>
      {/* Scroll-to-bottom pill: floats above the ComposeBar, only when the
          user has scrolled up and the conversation has content. Pointer-events
          gated so the pill doesn't catch clicks when hidden. */}
      {!pinnedToBottom && (messages.data?.length ?? 0) > 0 && (
        <div className="relative h-0 z-10 pointer-events-none">
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            aria-label="scroll to latest"
            className={cn(
              'pointer-events-auto absolute left-1/2 -translate-x-1/2 bottom-3',
              'inline-flex items-center gap-1 rounded-full border border-border bg-background/95',
              'px-3 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur',
              'hover:bg-accent hover:text-foreground transition-colors cursor-pointer',
            )}
          >
            <span aria-hidden="true">↓</span> latest
          </button>
        </div>
      )}

      {showRestartBar ? (
        <RestartBar
          restarting={!!session?.restartRequestedAt || restartSession.isPending}
          onRestart={() => { restartSession.mutate({ id: sessionId }); setRestartArmed(true); }}
        />
      ) : (
        <>
          <LoopBar
            loopState={(session as { loopState?: unknown } | undefined)?.loopState}
            onStartLoop={() => pickPrompt(LOOP_TEMPLATE)}
            onStartCron={() => pickPrompt(CRON_TEMPLATE)}
            disabled={!!session?.closedAt}
          />
          <ComposeBar
            sessionId={sessionId}
            disabled={!!session?.closedAt}
            awaitingInput={!!pendingInteraction}
            sending={send.isPending}
            inFlight={isInFlight}
            stopping={cancelTurn.isPending}
            onStop={() => cancelTurn.mutate({ sessionId })}
            onSend={(text, images, files) => {
              // Sending always re-pins to the bottom (even if the user had
              // scrolled up) so their message + the reply scroll into view.
              scrollToBottom('auto');
              // Optimistic: show the user's bubble + clear the composer instantly
              // instead of waiting for the round-trip + SSE echo. The overlay row
              // drops itself when the real row lands (see `pending` / `view`);
              // restore the draft if the send itself fails.
              const prevDraft = draft;
              const prevAttachments = attachments;
              const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              if (text.trim()) {
                setPending((p) => [
                  ...p,
                  { id: optimisticId, role: 'user', content: [{ type: 'text', text }], createdAt: new Date().toISOString() },
                ]);
              }
              setDraft('');
              setAttachments([]);
              send.mutate(
                { sessionId, text, images, files },
                {
                  onError: () => {
                    setPending((p) => p.filter((x) => x.id !== optimisticId));
                    setDraft(prevDraft);
                    setAttachments(prevAttachments);
                  },
                },
              );
            }}
            draft={draft}
            setDraft={setDraft}
            attachments={attachments}
            setAttachments={setAttachments}
            taRef={taRef}
          />
        </>
      )}
    </>
  );
}

// Shown in place of the composer when the session's agent process is gone
// (gateway reports !alive, but it ran before). Typing would just queue a
// message the dead pane can't pick up, so we require an explicit restart —
// which kills any stale pane; the next message respawns claude via --resume
// with history preserved.
function RestartBar({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  return (
    <div className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-1">
        <div className="flex items-center justify-between gap-3 rounded-[26px] border border-border bg-muted/40 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" aria-hidden="true" />
            <span className="truncate">This session isn&apos;t active.</span>
          </div>
          <Button size="sm" onClick={onRestart} disabled={restarting} className="shrink-0">
            {restarting ? 'restarting…' : 'Restart to continue'}
          </Button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
          restart respawns the agent with history preserved (claude --resume)
        </p>
      </div>
    </div>
  );
}

// Claude Code's harness writes "No response requested." as the visible-text
// portion of an assistant turn whenever the model exited without producing
// substantive output — typically post-restart `--resume` picking up a half-
// finished tool task, a prompt the model read as pure instruction, or a turn
// killed mid-tool-call. It's a JSONL terminator marker, not the model's
// real reply. We keep the row visible (so the timeline doesn't lose a turn
// boundary), but swap the misleading text for an honest one-liner explaining
// what actually happened. Accepts accompanying thinking/empty blocks; bails
// on anything else (tool_use / tool_result / image / real text).
function isHarnessTerminator(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  let sawTerminator = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') return false;
    if (b.type === 'thinking') continue;
    if (b.type === 'text') {
      const text = String(b.text ?? '').trim();
      if (!text) continue;
      if (/^no response requested\.?$/i.test(text)) {
        sawTerminator = true;
        continue;
      }
      return false;
    }
    return false;
  }
  return sawTerminator;
}

function HarnessTerminatorRow({ ts }: { ts: Date | string }) {
  return (
    <div className="flex justify-center my-2">
      <span
        className="text-[11px] italic text-muted-foreground/70 font-mono px-2 py-0.5 rounded border border-dashed border-border"
        title="Claude Code 在没产出回复文字的情况下结束了这一轮 — 通常发生在 restart 后 --resume 接续上一轮被中断的 tool 调用、或 prompt 被模型读成纯指令时。"
      >
        — turn ended without a reply · {relTime(ts)}
      </span>
    </div>
  );
}

const MessageTimeline = memo(function MessageTimeline({ messages, streamingTailId, dotClass }: { messages: Array<{ id: string; role: string; content: any; createdAt: Date | string }>; streamingTailId?: string | null; dotClass?: string }) {
  // Insert date dividers when day rolls over. Also coalesce consecutive
  // tool-result-only messages into a single row so a parallel-fanout batch
  // (e.g. 6 Read calls → 6 result rows) collapses to one expandable chip.
  const out: React.ReactNode[] = [];
  let prevDay: Date | string | null = null;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!prevDay || !isSameDay(prevDay, m.createdAt)) {
      out.push(<DateDivider key={`d-${m.id}`} day={m.createdAt} />);
      prevDay = m.createdAt;
    }
    // Harness "No response requested." terminator → render as a small dashed
    // pill explaining what actually ended the turn, not as a normal bubble.
    if (m.role === 'assistant' && isHarnessTerminator(m.content)) {
      out.push(<HarnessTerminatorRow key={m.id} ts={m.createdAt} />);
      i += 1;
      continue;
    }
    const blocks = m.content as Block[];
    const isToolResultOnly = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    if (isToolResultOnly) {
      const combined: Block[] = [...blocks];
      let lastId = m.id;
      let j = i + 1;
      while (j < messages.length) {
        const nb = messages[j].content as Block[];
        const nIsToolResultOnly = nb.length > 0 && nb.every((b) => b.type === 'tool_result');
        if (!nIsToolResultOnly) break;
        if (!isSameDay(prevDay!, messages[j].createdAt)) break;
        combined.push(...nb);
        lastId = messages[j].id;
        j++;
      }
      out.push(<MessageRow key={`g-${m.id}-${lastId}`} role={m.role} content={combined} ts={m.createdAt} />);
      i = j;
    } else {
      const streamingTail = !!streamingTailId && m.id === streamingTailId;
      // Typewriter is decided at render time, NOT from streamingTailId — that's
      // set by a post-render effect (one render late), which would mount the
      // text already-complete and skip the animation. The last assistant row,
      // if it landed in the last few seconds, types out.
      const isLast = i === messages.length - 1;
      const typing = isLast && m.role === 'assistant' && Date.now() - new Date(m.createdAt).getTime() < 8_000;
      out.push(<MessageRow key={m.id} role={m.role} content={blocks} ts={m.createdAt} streamingTail={streamingTail} typing={typing} streamingDot={streamingTail ? dotClass : undefined} />);
      i += 1;
    }
  }
  return <div className="space-y-3">{out}</div>;
});

function DateDivider({ day }: { day: Date | string }) {
  const label = useMemo(() => {
    const x = typeof day === 'string' ? new Date(day) : day;
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (isSameDay(x, now)) return 'Today';
    if (isSameDay(x, yesterday)) return 'Yesterday';
    return ymdLocal(x);
  }, [day]);
  return (
    <div className="flex justify-center my-5">
      <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted-foreground/60 px-2">
        {label}
      </span>
    </div>
  );
}

function TypingIndicator({ dot }: { dot: string }) {
  return (
    <div className="flex justify-start mt-2">
      <StreamingDots variant="bubble" dot={dot} />
    </div>
  );
}

function EmptyChat({ agentName, onPickPrompt }: { agentName?: string; onPickPrompt: (s: string) => void }) {
  const initials = (agentName ?? '?').slice(0, 2).toUpperCase();
  const suggestions = useMemo(
    () => [
      { title: 'Say hi', body: `say hi to ${agentName ?? 'them'}` },
      { title: 'Check in', body: 'what are you working on right now?' },
      { title: 'Triage failures', body: 'anything broken? show me recent failures from your daily log' },
      { title: 'Reflect', body: 'what did you learn this week? any patterns worth saving to evolution.md?' },
    ],
    [agentName],
  );
  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col items-center justify-center px-4 py-16 text-center">
      <div
        className="h-16 w-16 rounded-2xl bg-foreground text-background flex items-center justify-center font-mono text-base font-medium shadow-sm"
        aria-hidden="true"
      >
        {initials}
      </div>
      <h3 className="mt-5 text-lg font-medium tracking-tight text-foreground">
        Start a chat with <span className="font-mono">{agentName ?? '?'}</span>
      </h3>
      <p className="mt-1.5 text-xs text-muted-foreground">pick a starter, or just type below</p>
      <div className="w-full max-w-xl mt-7 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {suggestions.map((s, i) => (
          <button
            type="button"
            key={i}
            onClick={() => onPickPrompt(s.body)}
            className="group h-full text-left rounded-xl border border-border bg-background px-3.5 py-3 hover:border-foreground/30 hover:bg-accent/40 transition-colors cursor-pointer"
          >
            <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground/80 group-hover:text-foreground/80 transition-colors">
              {s.title}
            </div>
            <div className="mt-1 text-sm text-foreground/85 line-clamp-2">{s.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Claude Code built-in slash commands the composer suggests when the user
// types "/". Picking one fills the draft; sending sends it as a normal user
// message — it lands in the agent's REPL via tmux send-keys and claude runs
// it just like a typed slash command. Interactive ones (/help, /memory, etc.)
// are intentionally omitted: they open TUI modals that hang the headless pane.
const SLASH_COMMANDS: Array<{ name: string; hint: string; needsArgs?: boolean }> = [
  { name: '/compact',  hint: '压缩上下文' },
  { name: '/clear',    hint: '清空对话' },
  { name: '/status',   hint: '当前会话状态' },
  { name: '/model',    hint: '切换模型（如 opus / sonnet）', needsArgs: true },
  { name: '/goal',     hint: '设置 / 查看目标' },
  { name: '/exit',     hint: '退出会话' },
  { name: '/logout',   hint: '退出登录' },
];

// Natural-language template the "开启循环任务" suggestion drops into the
// composer. /loop left the slash picker (loops are natural-language now), so
// this guided starter is the entry point. The loop skill matches on 循环/每 X/
// 直到 and sets up a session-scoped recurring task whose every iteration
// streams back into THIS conversation.
const LOOP_TEMPLATE =
  '开启循环任务：每 1 小时，<要做的事>。每轮做完都自己测试验证一遍，再把结果（含验证结论）发到这个对话；达成 <完成条件> 后自动停止。';

// Cron sibling of LOOP_TEMPLATE. The cron skill matches on 定时/每 X/cron and
// creates a DURABLE background task via mcp__hermit__cron_create — results land
// on the /cron page, not in this chat (that is what makes it a cron, not a loop).
const CRON_TEMPLATE =
  '开启定时任务：每 60 分钟（时间上下浮动 ±10 分钟），<要做的事>。后台定时跑，结果记录到 /cron 页面（不发到这个对话）。';

interface LoopEntry {
  id?: string;
  kind?: string;
  schedule?: string;
  prompt?: string;
  status?: string;
  runCount?: number;
  createdAt?: string;
  lastRunAt?: string;
  lastResult?: string;
}

// Strip above the composer: each active loop as a status card (click to expand
// details), a compact count of any scheduled routines, and a persistent
// "开启循环任务" suggestion that fills the composer with a template. Loop and
// schedule data is the opaque JSON the gateway forwards from
// `<agent_dir>/.loop-state.json` → `session.loopState`.
function LoopBar({
  loopState,
  onStartLoop,
  onStartCron,
  disabled,
}: {
  loopState: unknown;
  onStartLoop: () => void;
  onStartCron: () => void;
  disabled?: boolean;
}) {
  const s =
    loopState && typeof loopState === 'object'
      ? (loopState as { loops?: unknown[]; schedules?: unknown[] })
      : null;
  const loops = (s && Array.isArray(s.loops) ? s.loops : []) as LoopEntry[];
  const schedules = (s && Array.isArray(s.schedules) ? s.schedules : []) as Array<{
    id?: string;
    cron?: string;
    prompt?: string;
  }>;

  return (
    <div className="shrink-0 bg-background pt-2">
      {/* Match ComposeBar's container (mx-auto w-full max-w-3xl px-3) exactly so
          the suggestion chip's left edge lines up with the composer box. */}
      <div className="mx-auto w-full max-w-3xl px-3 flex flex-col gap-1.5">
        {loops.map((l, i) => (
          <LoopCard key={typeof l.id === 'string' ? l.id : `loop-${i}`} loop={l} />
        ))}
        <div className="flex items-center gap-2 flex-wrap">
          {!disabled && (
            <button
              type="button"
              onClick={onStartLoop}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-emerald-500" aria-hidden="true">↻</span>
              开启循环任务
            </button>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={onStartCron}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-sky-500" aria-hidden="true">⏰</span>
              开启定时任务
            </button>
          )}
          {schedules.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="text-sky-500" aria-hidden="true">⏰</span>
              <span className="tabular-nums">{schedules.length}</span> scheduled
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// One active loop, collapsed to a status line; click toggles a detail panel.
function LoopCard({ loop }: { loop: LoopEntry }) {
  const id = typeof loop.id === 'string' ? loop.id : 'loop';
  const status = typeof loop.status === 'string' ? loop.status : 'running';
  const runCount = typeof loop.runCount === 'number' ? loop.runCount : null;
  const schedule = loop.schedule ?? loop.kind ?? 'loop';
  const stopped = status !== 'running';
  return (
    <details className="group rounded-lg border border-border bg-card">
      <summary className="cursor-pointer list-none flex items-center gap-2 px-2.5 h-9 text-[12px]">
        <span
          className={cn('shrink-0', stopped ? 'text-muted-foreground' : 'text-emerald-500')}
          aria-hidden="true"
        >
          {stopped ? '■' : '↻'}
        </span>
        <span className="font-medium text-foreground truncate">{schedule}</span>
        {loop.prompt && (
          <span className="text-muted-foreground truncate hidden sm:inline">· {loop.prompt}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-muted-foreground">
          {runCount != null && <span className="tabular-nums">已跑 {runCount}</span>}
          <span className="text-[10px] uppercase tracking-wide">{status}</span>
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className="border-t border-border px-3 py-2 text-[12px] space-y-1">
        {loop.prompt && <LoopDetail k="任务" v={loop.prompt} />}
        <LoopDetail k="节奏" v={schedule} />
        {loop.kind && <LoopDetail k="类型" v={loop.kind} />}
        {runCount != null && <LoopDetail k="已运行" v={`${runCount} 次`} />}
        {loop.lastRunAt && <LoopDetail k="上次" v={new Date(loop.lastRunAt).toLocaleString()} />}
        {loop.createdAt && <LoopDetail k="开始" v={new Date(loop.createdAt).toLocaleString()} />}
        {loop.lastResult && (
          <div className="pt-1">
            <div className="text-muted-foreground/70 text-[11px] mb-0.5">上次结果</div>
            <div className="text-foreground/90 whitespace-pre-wrap line-clamp-4">{loop.lastResult}</div>
          </div>
        )}
        <div className="text-muted-foreground/60 text-[11px] pt-1.5 mt-1 border-t border-border/60">
          {id.slice(0, 12)} · 结果持续发到本对话 · 重启即停
        </div>
      </div>
    </details>
  );
}

function LoopDetail({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground/70 w-12 shrink-0">{k}</span>
      <span className="text-foreground/90 min-w-0 break-words">{v}</span>
    </div>
  );
}

function ComposeBar({
  sessionId,
  disabled,
  awaitingInput = false,
  sending,
  inFlight,
  stopping,
  onStop,
  draft,
  setDraft,
  attachments,
  setAttachments,
  onSend,
  taRef,
}: {
  sessionId: string;
  disabled: boolean;
  awaitingInput?: boolean;
  sending: boolean;
  inFlight: boolean;
  stopping: boolean;
  onStop: () => void;
  draft: string;
  setDraft: (s: string) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onSend: (
    text: string,
    images: Array<{ url: string; mimeType: string; width: number | null; height: number | null }>,
    files: Array<{ url: string; mimeType: string; name: string }>,
  ) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea: clamp height between 1 and 12 rows.
  const onChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [setDraft]);

  // When the draft is cleared programmatically (after sending — which doesn't
  // fire onChange), the imperatively-set height sticks, leaving the composer
  // tall-but-empty. Collapse it back to one row whenever the draft empties.
  useEffect(() => {
    if (draft === '' && taRef.current) taRef.current.style.height = 'auto';
  }, [draft, taRef]);

  // On mount, size the box to fit a restored draft — no onChange fires for a
  // value loaded from storage, so the height would otherwise stay at one row.
  useEffect(() => {
    const el = taRef.current;
    if (el && el.value) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 360)}px`; }
    // mount-only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload one or more files (image or otherwise) to /api/upload; track each via
  // an Attachment record so the UI shows a thumbnail/chip + spinner. Images get
  // an object-URL preview; other files get a generic chip.
  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      const name = file.name || (isImage ? 'pasted-image' : 'file');
      // Whitelist non-image extensions client-side so we surface a friendly
      // error chip without a useless upload roundtrip. Server-side
      // /api/upload enforces the same set as defense-in-depth.
      if (!isImage) {
        const ext = getExt(name);
        if (!SAFE_FILE_EXT_SET.has(ext)) {
          setAttachments((prev) => [...prev, { id, kind: 'error', name, error: `unsupported file type${ext ? ` (.${ext})` : ''}` }]);
          continue;
        }
      }
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [...prev, { id, kind: 'uploading', name, isImage, previewUrl }]);
      // Read pixel dims in the browser, in parallel with the upload. The server
      // tries too (sips/identify), but those may be absent on the deploy box —
      // the client read guarantees the chip shows real W×H, not "?×?".
      const clientDimsP = isImage ? readImageDims(file) : Promise.resolve(null);
      try {
        const fd = new FormData();
        fd.append('sessionId', sessionId);
        fd.append('file', file);
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-asst-key': getStoredKey() }, body: fd });
        if (!r.ok) throw new Error(`upload failed (${r.status}): ${await r.text().catch(() => '')}`);
        const data = await r.json() as { url: string; mimeType: string; width: number | null; height: number | null };
        const clientDims = await clientDimsP;
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'ready', name, isImage, previewUrl, data: { url: data.url, mimeType: data.mimeType, width: data.width ?? clientDims?.width ?? null, height: data.height ?? clientDims?.height ?? null } } : a));
      } catch (e) {
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'error', name, error: e instanceof Error ? e.message : String(e) } : a));
      }
    }
  }, [sessionId, setAttachments]);

  const onPickFiles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void addFiles(files);
    e.target.value = ''; // allow re-picking the same file
  }, [addFiles]);

  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && f.type.startsWith('image/')) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }, [addFiles]);

  const [dragHover, setDragHover] = useState(false);
  const onDragOver = useCallback((e: DragEvent<HTMLFormElement>) => {
    if (Array.from(e.dataTransfer.items).some((it) => it.kind === 'file')) {
      e.preventDefault();
      setDragHover(true);
    }
  }, []);
  const onDragLeave = useCallback(() => setDragHover(false), []);
  const onDrop = useCallback((e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragHover(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }, [addFiles]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target && 'previewUrl' in target && target.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, [setAttachments]);

  const readyAttachments = useMemo(
    () => attachments.filter((a): a is Attachment & { kind: 'ready' } => a.kind === 'ready'),
    [attachments],
  );
  const uploadingCount = attachments.filter((a) => a.kind === 'uploading').length;

  const submit = () => {
    const text = draft.trim();
    if (sending || disabled || inFlight) return;
    if (!text && readyAttachments.length === 0) return;
    const images = readyAttachments
      .filter((a) => a.isImage)
      .map((a) => ({ url: a.data.url, mimeType: a.data.mimeType, width: a.data.width, height: a.data.height }));
    const files = readyAttachments
      .filter((a) => !a.isImage)
      .map((a) => ({ url: a.data.url, mimeType: a.data.mimeType, name: a.name }));
    onSend(text, images, files);
    noteSlashCommand(text);
  };

  // ── Slash-command picker ───────────────────────────────────────────────
  // Open whenever the draft is "/" followed only by letters (no whitespace
  // yet — once the user starts typing args the picker gets out of the way).
  // ↑/↓ navigate, Enter sends (or picks if the command needs args), Tab picks
  // without sending, Esc clears.
  const slashPrefix = /^\/[a-zA-Z]*$/.test(draft) ? draft.toLowerCase() : null;
  const slashFiltered = useMemo(
    () => (slashPrefix == null ? [] : SLASH_COMMANDS.filter((c) => c.name.startsWith(slashPrefix))),
    [slashPrefix],
  );
  const slashOpen = slashFiltered.length > 0;
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => { setSlashIdx(0); }, [slashPrefix]);
  const pickCommand = useCallback((cmd: (typeof SLASH_COMMANDS)[number]) => {
    setDraft(cmd.needsArgs ? cmd.name + ' ' : cmd.name);
    taRef.current?.focus();
  }, [setDraft, taRef]);

  // Most slash commands (/status, /clear, /model, …) print to claude's TUI
  // panel but never write to the JSONL we tail — so without follow-up the
  // dashboard sits forever on "assistant is working…" (lastMsg.role === 'user').
  // Right after dispatching, append a tiny "↳ sent /X" system note: it both
  // confirms the command landed AND flips the in-flight heuristic.
  const appendSystemNote = trpc.chat.appendSystemNote.useMutation();
  const noteSlashCommand = useCallback((text: string) => {
    const m = /^\/(\w+)/.exec(text.trim());
    if (m) appendSystemNote.mutate({ sessionId, text: `↳ sent /${m[1]}` });
  }, [appendSystemNote, sessionId]);

  // While the assistant is producing output, swap the send button for a stop.
  const showStop = inFlight && !disabled;
  const canSend = !sending && !disabled && !inFlight && !awaitingInput && (draft.trim().length > 0 || readyAttachments.length > 0);

  return (
    <form
      className={cn('shrink-0 bg-background transition-colors', dragHover && 'bg-accent/30')}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-1">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
        <div
          className={cn(
            'relative flex items-end gap-1.5 rounded-[26px] border bg-background px-2 py-2 shadow-sm transition-all duration-100 ease-out',
            disabled || awaitingInput
              ? 'border-border opacity-60'
              : showStop
              ? 'border-rose-500/40'
              : dragHover
              ? 'border-foreground/40'
              : 'border-border focus-within:border-foreground/40 focus-within:shadow-md',
          )}
        >
          {slashOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover shadow-lg p-1 z-30 max-h-72 overflow-y-auto">
              {slashFiltered.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  onMouseDown={(ev) => { ev.preventDefault(); pickCommand(c); }}
                  onMouseEnter={() => setSlashIdx(i)}
                  className={cn(
                    'w-full text-left flex items-baseline gap-3 px-2.5 py-1.5 rounded-md text-sm transition-colors cursor-pointer',
                    i === slashIdx ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <span className="font-mono font-medium text-foreground shrink-0">{c.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{c.hint}</span>
                </button>
              ))}
            </div>
          )}
          {/* upload affordance: one + button. accept includes images and a
              whitelist of safe text / code / pdf extensions; binaries /
              archives / executables are rejected client- and server-side. */}
          <input ref={fileInputRef} type="file" accept={FILE_ACCEPT} multiple hidden onChange={onPickFiles} />
          <div className="flex items-center shrink-0 pb-0.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || showStop || awaitingInput}
              aria-label="attach image or file"
              title="Attach an image or file"
              className="h-9 w-9 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>

          <textarea
            ref={taRef}
            value={draft}
            onChange={onChange}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(slashFiltered.length - 1, i + 1)); return; }
                if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx((i) => Math.max(0, i - 1)); return; }
                if (e.key === 'Tab')       { e.preventDefault(); pickCommand(slashFiltered[slashIdx]); return; }
                if (e.key === 'Escape')    { e.preventDefault(); setDraft(''); return; }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && !isTouchPrimary()) {
                  e.preventDefault();
                  const cmd = slashFiltered[slashIdx];
                  if (cmd.needsArgs) pickCommand(cmd);
                  else if (!sending && !disabled && !inFlight && !awaitingInput) { onSend(cmd.name, [], []); noteSlashCommand(cmd.name); }
                  return;
                }
              }
              if (e.key !== 'Enter') return;
              // IME composition (中文输入法 etc.): Enter confirms a candidate.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.shiftKey) return;
              // Mobile: let the return key insert a newline (send via button).
              if (isTouchPrimary()) return;
              e.preventDefault();
              submit();
            }}
            placeholder={
              disabled
                ? 'session is closed'
                : awaitingInput
                ? '↑ respond above to continue'
                : showStop
                ? 'assistant is working… (esc to stop)'
                : uploadingCount > 0
                ? `uploading ${uploadingCount}…`
                : 'Ask anything'
            }
            disabled={disabled || showStop || awaitingInput}
            rows={1}
            className="flex-1 bg-transparent text-base sm:text-[15px] resize-none outline-none leading-relaxed min-h-[28px] max-h-[360px] overflow-auto py-1.5 text-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
          />

          {showStop ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full cursor-pointer bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-wait transition-colors"
              aria-label={stopping ? 'stopping' : 'stop assistant turn'}
              title={stopping ? 'stopping…' : 'stop assistant turn'}
            >
              <span className="h-3 w-3 rounded-[3px] bg-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className={cn(
                'h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-all',
                canSend
                  ? 'bg-foreground text-background hover:bg-foreground/90 cursor-pointer shadow-sm'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
              aria-label="send"
              title={canSend ? 'send (↵)' : 'type a message'}
            >
              {sending ? <span className="text-sm">…</span> : <ArrowUp className="h-5 w-5" />}
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
          messages go to the agent&apos;s terminal · ↵ send · ⇧↵ newline · paste or drop images
        </p>
      </div>
    </form>
  );
}

// Decode an image file in the browser just far enough to read its pixel size.
// Resolves null on any failure (non-image, decode error) so callers can fall
// back without a try/catch. Independent of server-side sips/identify, which
// may be missing on the deploy box.
// Non-image file extensions accepted by /api/upload. Anything outside this
// list is rejected before the upload roundtrip (and again on the server) —
// keeps loose binaries / executables out (gibberish in context / a security
// concern). Archives ARE allowed: stored as-is, the gateway hands the agent an
// "extract via Bash" instruction instead of Read'ing them. Mirror of
// `SAFE_FILE_EXT_SET` in apps/dashboard/src/app/api/upload/route.ts.
const SAFE_FILE_EXTS = [
  // text & docs
  'txt','md','markdown','rtf','log','pdf',
  // data / config
  'json','yaml','yml','toml','ini','conf','env','xml','html','svg','csv','tsv','sql',
  // source
  'ts','tsx','js','jsx','mjs','cjs','py','rb','php','go','rs',
  'c','cpp','cc','cxx','h','hpp','java','kt','swift','scala','clj','ex','exs',
  'sh','bash','zsh','fish','ps1','dart','lua','r',
  // archives — stored as-is; the agent extracts them via Bash (never Read'd)
  'zip','tar','gz','tgz','bz2','tbz2','xz','txz','7z','rar','zst',
] as const;
const SAFE_FILE_EXT_SET = new Set<string>(SAFE_FILE_EXTS);
// `<input accept>` value: `image/*` + every whitelisted file extension.
const FILE_ACCEPT = 'image/*,' + SAFE_FILE_EXTS.map((e) => '.' + e).join(',');

function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function readImageDims(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ok = img.naturalWidth > 0 && img.naturalHeight > 0;
      URL.revokeObjectURL(url);
      resolve(ok ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Sub-label under an attachment's filename. Real pixel dims for images (read
// client-side, so it survives a server without sips/identify); a type hint for
// everything else — never a bogus "?×?".
function readyLabel(a: Extract<Attachment, { kind: 'ready' }>): string {
  if (a.data.width && a.data.height) return `${a.data.width}×${a.data.height}`;
  if (a.isImage) return 'image';
  const sub = a.data.mimeType.split('/')[1];
  if (sub && sub !== 'octet-stream') return sub;
  const ext = a.name.includes('.') ? a.name.split('.').pop()! : '';
  return ext || 'file';
}

function AttachmentChip({ attachment: a, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const previewUrl = 'previewUrl' in a ? a.previewUrl : null;
  return (
    <div className="relative group inline-flex items-center gap-2 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] font-mono">
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={a.name} className={cn(
          'h-10 w-10 rounded object-cover',
          a.kind === 'uploading' && 'opacity-50',
          a.kind === 'error' && 'opacity-30 grayscale',
        )} />
      ) : (
        <div className="h-10 w-10 rounded bg-muted text-muted-foreground/70 flex items-center justify-center">
          {a.kind === 'error' ? '!' : <FileText className="h-5 w-5" />}
        </div>
      )}
      <div className="min-w-0 max-w-[120px]">
        <div className="truncate text-foreground/80">{a.name}</div>
        <div className={cn(
          'text-[10px] tabular-nums',
          a.kind === 'uploading' && 'text-muted-foreground',
          a.kind === 'ready' && 'text-emerald-600',
          a.kind === 'error' && 'text-rose-500',
        )}>
          {a.kind === 'uploading' ? 'uploading…' : a.kind === 'error' ? a.error.slice(0, 40) : readyLabel(a)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="remove attachment"
        className="opacity-60 hover:opacity-100 hover:text-rose-500 px-1 text-xs cursor-pointer"
      >
        ×
      </button>
    </div>
  );
}

const MessageRow = memo(function MessageRow({ role, content, ts, streamingTail = false, typing = false, streamingDot }: { role: string; content: Block[]; ts: Date | string; streamingTail?: boolean; typing?: boolean; streamingDot?: string }) {
  // Tool-result-only rows belong with the assistant's preceding tool calls,
  // so we render them as condensed inline chips with no bubble.
  const allToolResults = content.length > 0 && content.every((b) => b.type === 'tool_result');
  if (allToolResults) {
    const results = content as Array<{ type: string; tool_use_id?: string; content?: any; is_error?: boolean }>;
    if (results.length === 1) {
      return (
        <div className="flex justify-start">
          <div className="min-w-0 max-w-[85%]"><InlineToolResult block={results[0]} /></div>
        </div>
      );
    }
    return (
      <div className="flex justify-start">
        <div className="min-w-0 max-w-[85%]"><InlineToolResultBatch results={results} /></div>
      </div>
    );
  }

  const isHumanUser = role === 'user';
  const isSystem = role === 'system';

  // Group consecutive same-tool tool_use calls so a noisy claude turn doesn't
  // generate 12 individual cards.
  const grouped = groupConsecutiveTools(content);
  const hasVisibleText = content.some((b) => b.type === 'text' && (b as any).text?.trim());

  // Tool-use-only assistant turns: render the chips bare (no bubble, no
  // placeholder text). They belong visually with the surrounding tool_result
  // chips, not as standalone cards with empty bodies. When this row is the
  // streaming tail, append a small dots chip at the end of the chip cluster.
  if (!isHumanUser && !isSystem && !hasVisibleText && grouped.every((g) => g.kind === 'tool' || g.kind === 'thinking')) {
    return (
      <div className="flex justify-start">
        <div className="min-w-0 max-w-[85%] space-y-1.5">
          {grouped.map((g, i) => (
            <GroupView key={i} group={g} dark inline />
          ))}
          {streamingTail && (
            <div className="flex">
              <StreamingDots variant="chip" dot={streamingDot} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Flatten visible text blocks into one plain-text string so the hover Copy
  // action grabs only what the user can actually read (skip tool calls,
  // thinking, images). Used by MessageActions below.
  const plainText = content
    .filter((b) => b.type === 'text' && (b as { text?: string }).text)
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n\n')
    .trim();

  // System messages (gateway-emitted banners like "[session restarted —
  // send a message to continue]") should read as inline notices, not real
  // conversation. Render them centered, muted, and full-width with a hairline
  // divider treatment instead of the loud amber bubble.
  if (isSystem) {
    // Interaction cards (permission / question prompts) carry their own border +
    // controls, so render them full-width and centered — never inside the pill.
    if (grouped.some((g) => g.kind === 'interaction')) {
      return (
        <div className="flex justify-center my-2">
          <div className="w-full max-w-[92%] space-y-2">
            {grouped.map((g, i) => (
              <GroupView key={i} group={g} dark={false} />
            ))}
          </div>
        </div>
      );
    }
    // Short notices (one-liners like "[session restarted]") render as the
    // existing hairline pill. Long ones (captured slash-command TUI output,
    // multi-line errors, etc.) get a wider card so any fenced code block
    // inside has room — a pill would either clip or stretch oddly.
    const sysText = grouped.map((g) => (g.kind === 'text' ? g.text : '')).join('');
    const isLong = sysText.includes('\n') || sysText.length > 100;
    if (isLong) {
      return (
        <div className="flex justify-center my-2">
          <div className="max-w-[92%] w-full text-xs text-muted-foreground/90 px-3 py-2 rounded-md border border-border bg-muted/40">
            {grouped.map((g, i) => (
              <GroupView key={i} group={g} dark={false} />
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-center my-2">
        <div className="text-[11px] text-muted-foreground/80 font-mono px-3 py-1 rounded-full border border-border bg-muted/40">
          {grouped.map((g, i) => (
            <GroupView key={i} group={g} dark={false} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`group/msg flex ${isHumanUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={cn(
          'min-w-0 max-w-[85%] space-y-2 text-sm',
          isHumanUser
            ? 'rounded-md px-3 py-2 bg-foreground text-background'
            : 'text-foreground/90',
        )}
      >
        {grouped.map((g, i) => (
          <GroupView key={i} group={g} dark={false} typing={typing && !isHumanUser} />
        ))}
        {streamingTail && (
          <div className="flex">
            <StreamingDots variant="bubble" dot={streamingDot} />
          </div>
        )}
        <div className={cn(
          'flex items-center gap-1.5 pt-0.5',
          isHumanUser ? 'justify-end' : 'justify-start',
        )}>
          <div className={cn(
            'text-[10px] font-mono tabular-nums',
            isHumanUser ? 'text-background/60' : 'text-muted-foreground/60',
          )}>
            {relTime(ts)}
          </div>
          {/* Hidden until row hover (or focus inside), to keep the rest text. */}
          {plainText && !streamingTail && !isSystem && (
            <MessageActions
              text={plainText}
              tone={isHumanUser ? 'on-dark' : 'on-light'}
            />
          )}
        </div>
      </div>
    </div>
  );
});

// Compact hover-action cluster shown below a message bubble. Currently just
// Copy; adding Edit/Regenerate later means dropping more icon buttons here.
// `tone` flips foreground colors so the icon stays readable on light vs dark
// bubble backgrounds.
function MessageActions({ text, tone }: { text: string; tone: 'on-light' | 'on-dark' }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard write can fail in non-secure contexts or when permission is
      // denied — silently swallow rather than throw at the user.
    }
  }, [text]);
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'copied' : 'copy message'}
      title={copied ? 'copied' : 'copy'}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-opacity cursor-pointer',
        // Desktop (hover-capable): hidden until the row is hovered or a key
        // grabs focus, so the conversation stays clean to read. Touch devices
        // (`hover: none`) can't discover via hover, so always show the button —
        // slightly muted, tap to copy. Both user and assistant rows render this
        // (different `tone`); the previous always-invisible default meant the
        // assistant copy button felt missing on phones.
        'opacity-0 group-hover/msg:opacity-100 focus-visible:opacity-100',
        '[@media(hover:none)]:opacity-80',
        tone === 'on-dark'
          ? 'text-background/80 hover:text-background hover:bg-background/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent',
      )}
    >
      {copied ? '✓ copied' : 'copy'}
    </button>
  );
}

// "Thinking" indicator — a single solid dot that gently breathes (scale +
// opacity), ChatGPT style. `variant` only nudges the size: a touch smaller
// when it sits inline at the tail of a tool-chip cluster.
function StreamingDots({ variant, dot = 'bg-foreground' }: { variant: 'bubble' | 'chip'; dot?: string }) {
  return (
    <span
      aria-label="assistant is thinking"
      className={cn(
        'inline-block shrink-0 rounded-full align-middle motion-safe:animate-[breathe_1.4s_ease-in-out_infinite]',
        dot,
        variant === 'chip' ? 'h-2.5 w-2.5' : 'h-3 w-3',
      )}
    />
  );
}

type Group =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; calls: Array<{ id: string; name: string; input: any }> }
  | { kind: 'image'; url: string; mimeType: string | null; width: number | null; height: number | null }
  | { kind: 'file'; url: string; name: string; mimeType: string | null }
  | { kind: 'interaction'; block: any }
  | { kind: 'unknown'; block: Block };

// Coerce an Anthropic image block's `source` into a URL the dashboard can show.
// Three variants in the wild:
//   { type: 'url', url: '/uploads/...' }              → our composer uploads
//   { type: 'url', url: 'https://…' }                 → external (gateway-relayed)
//   { type: 'base64', media_type, data }              → MCP attach_image-style
function imageSourceToUrl(src: any): { url: string; mimeType: string | null } | null {
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'url' && typeof src.url === 'string') {
    return { url: src.url, mimeType: src.media_type ?? null };
  }
  if (src.type === 'base64' && typeof src.data === 'string') {
    const mt = src.media_type || 'image/png';
    return { url: `data:${mt};base64,${src.data}`, mimeType: mt };
  }
  return null;
}

function groupConsecutiveTools(blocks: Block[]): Group[] {
  const out: Group[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text) out.push({ kind: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      const t = (b as any).thinking ?? (b as any).text;
      if (t) out.push({ kind: 'thinking', text: String(t) });
    } else if (b.type === 'tool_use') {
      const prev = out[out.length - 1];
      const call = { id: (b as any).id ?? '', name: (b as any).name ?? '?', input: (b as any).input ?? {} };
      if (prev && prev.kind === 'tool') prev.calls.push(call);
      else out.push({ kind: 'tool', calls: [call] });
    } else if (b.type === 'image') {
      const src = imageSourceToUrl(b.source);
      if (src) {
        out.push({
          kind: 'image',
          url: src.url,
          mimeType: src.mimeType,
          width: typeof b.width === 'number' ? b.width : null,
          height: typeof b.height === 'number' ? b.height : null,
        });
      }
    } else if (b.type === 'file') {
      const src: any = b.source;
      const url = src && typeof src === 'object' && typeof src.url === 'string' ? src.url : null;
      if (url) out.push({ kind: 'file', url, name: typeof b.name === 'string' && b.name ? b.name : 'file', mimeType: typeof src.media_type === 'string' ? src.media_type : null });
    } else if (b.type === 'interaction') {
      out.push({ kind: 'interaction', block: b });
    } else {
      out.push({ kind: 'unknown', block: b });
    }
  }
  return out;
}

// Typewriter reveal for the streaming tail's assistant text. The server sends
// whole content blocks (no token deltas — see the SSE route), so the "typing"
// is synthesized client-side: reveal plain text char-by-char (cheap, no
// markdown re-parse mid-type), then settle into rendered Markdown once the
// block is fully shown. Honors prefers-reduced-motion.
function useTypewriter(text: string, enabled: boolean): number {
  const [shown, setShown] = useState(enabled ? 0 : text.length);
  useEffect(() => {
    if (!enabled) { setShown(text.length); return; }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      setShown(text.length);
      return;
    }
    let raf = 0;
    let last = 0;
    const step = (now: number) => {
      if (now - last >= 28) {
        last = now;
        // ease-out: reveal a chunk proportional to what's left (≈0.85s to full,
        // regardless of length), so short blocks finish fast and long ones glide.
        setShown((cur) => (cur >= text.length ? cur : Math.min(text.length, cur + Math.max(2, Math.round((text.length - cur) * 0.14)))));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, enabled]);
  return Math.min(shown, text.length);
}

function TypedText({ text, typing }: { text: string; typing: boolean }) {
  const shown = useTypewriter(text, typing);
  if (shown >= text.length) return <Markdown>{text}</Markdown>;
  return <span className="whitespace-pre-wrap break-words">{text.slice(0, shown)}</span>;
}

// A chat image: a capped thumbnail that opens a zoomable full-screen lightbox
// on click (instead of yanking the user to the raw file in a new tab).
function ChatImage({ url, width, height }: { url: string; width: number | null; height: number | null }) {
  const [open, setOpen] = useState(false);
  const alt = `attachment${width && height ? ` ${width}×${height}` : ''}`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="view image"
        className="inline-block cursor-zoom-in overflow-hidden rounded border border-border align-bottom transition-opacity hover:opacity-90"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={alt} className="max-h-[320px] max-w-[320px]" loading="lazy" />
      </button>
      <ImageLightbox open={open} onOpenChange={setOpen} url={url} alt={alt} />
    </>
  );
}

function GroupView({ group, dark, inline = false, typing = false }: { group: Group; dark: boolean; inline?: boolean; typing?: boolean }) {
  if (group.kind === 'text') return <TypedText text={group.text} typing={typing} />;
  if (group.kind === 'image') {
    return <ChatImage url={group.url} width={group.width} height={group.height} />;
  }
  if (group.kind === 'file') {
    return (
      <a
        href={group.url}
        download={group.name}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs no-underline transition-colors hover:border-foreground/30 hover:bg-accent/40"
      >
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground/90">{group.name}</span>
      </a>
    );
  }
  if (group.kind === 'thinking') {
    return (
      <details className="text-xs italic text-zinc-500/80">
        <summary className="cursor-pointer">💭 thinking</summary>
        <p className="mt-1 whitespace-pre-wrap">{group.text}</p>
      </details>
    );
  }
  if (group.kind === 'tool') {
    // Sub-group consecutive same-name calls so a turn with 8× Read renders as
    // a single "⚙ Read × 8" expandable chip instead of 8 wrapped chips.
    const byName: Array<{ name: string; calls: typeof group.calls }> = [];
    for (const c of group.calls) {
      const last = byName[byName.length - 1];
      if (last && last.name === c.name) last.calls.push(c);
      else byName.push({ name: c.name, calls: [c] });
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {byName.map((g, i) =>
          g.calls.length === 1 ? (
            <ToolChip key={g.calls[0].id || `${g.name}-${i}`} call={g.calls[0]} dark={dark} inline={inline} />
          ) : (
            <ToolBatchChip key={`${g.name}-${i}`} name={g.name} calls={g.calls} dark={dark} inline={inline} />
          ),
        )}
      </div>
    );
  }
  if (group.kind === 'interaction') {
    return <InteractionCard block={group.block} />;
  }
  return (
    <pre className="text-[11px] whitespace-pre-wrap text-zinc-500">
      [{group.block.type}] {JSON.stringify(group.block, null, 2).slice(0, 200)}
    </pre>
  );
}

// A blocking interaction the agent's turn is waiting on — rendered inline from
// a {type:'interaction'} content block. Permission → Allow/Deny; question →
// option buttons (+ free-text "Other"). Clicking calls interaction.resolve,
// which flips the row's status (unblocking the gateway hook / mcp ask tool) and
// rewrites this block to its resolved state on the next SSE refetch.
function InteractionCard({ block }: { block: any }) {
  const utils = trpc.useUtils();
  const resolve = trpc.interaction.resolve.useMutation({
    onSuccess: () => { utils.chat.listMessages.invalidate(); },
  });
  const kind: string = block?.kind ?? 'question';
  const payload = block?.payload ?? {};
  const status: string = block?.status ?? 'pending';
  const decision = block?.decision ?? null;
  const id: string = block?.interactionId ?? '';
  const resolved = status !== 'pending';
  const busy = resolve.isPending;

  if (resolved) {
    let summary = '—';
    if (kind === 'permission') {
      summary = decision?.behavior === 'allow' ? '✓ allowed' : '✕ denied';
    } else {
      const ans = Array.isArray(decision?.answers) ? decision.answers : [];
      summary = ans.length ? `✓ ${ans.join(', ')}` : 'dismissed';
    }
    return (
      <div className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/70">{kind === 'permission' ? 'Permission' : 'Asked'}</span>
        {' · '}
        {summary}
      </div>
    );
  }

  if (kind === 'permission') {
    const tool = payload?.tool ?? 'tool';
    const argPreview = oneLineArg(payload?.input ?? {});
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
        <div className="text-xs font-medium text-amber-700 dark:text-amber-400">🔐 Permission needed</div>
        <div className="mt-1.5 font-mono text-[12px] text-foreground break-all">
          {tool}
          {argPreview ? <span className="text-muted-foreground"> {argPreview}</span> : null}
        </div>
        {payload?.input && Object.keys(payload.input).length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">details</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1 text-[11px] text-foreground/80">
              {JSON.stringify(payload.input, null, 2)}
            </pre>
          </details>
        )}
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" disabled={busy || !id} className="h-8"
            onClick={() => resolve.mutate({ id, decision: { behavior: 'allow' } })}>
            Allow
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !id} className="h-8"
            onClick={() => resolve.mutate({ id, decision: { behavior: 'deny' } })}>
            Deny
          </Button>
        </div>
      </div>
    );
  }

  // question
  const question: string = payload?.question ?? '';
  const options: Array<{ label: string; description?: string }> = Array.isArray(payload?.options) ? payload.options : [];
  const multiSelect = !!payload?.multiSelect;
  return (
    <QuestionCard
      question={question}
      options={options}
      multiSelect={multiSelect}
      busy={busy || !id}
      onResolve={(answers) => id && resolve.mutate({ id, decision: { answers } })}
    />
  );
}

function QuestionCard({ question, options, multiSelect, busy, onResolve }: {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  busy: boolean;
  onResolve: (answers: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const toggle = (label: string) => {
    if (!multiSelect) { onResolve([label]); return; }
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };
  const submitMulti = () => {
    const answers = [...picked];
    if (custom.trim()) answers.push(custom.trim());
    if (answers.length) onResolve(answers);
  };
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
        ❓ {multiSelect ? 'Choose (one or more)' : 'Choose'}
      </div>
      {question && <div className="mt-1 whitespace-pre-wrap text-sm text-foreground">{question}</div>}
      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((o, i) => {
          const active = picked.includes(o.label);
          return (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => toggle(o.label)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50',
                active ? 'border-foreground bg-accent' : 'border-border hover:border-foreground/40 hover:bg-accent/40',
              )}
            >
              <span className="text-foreground">
                {multiSelect ? (active ? '☑ ' : '☐ ') : ''}
                {o.label}
              </span>
              {o.description && <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Other…"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !multiSelect && custom.trim()) { e.preventDefault(); onResolve([custom.trim()]); }
          }}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
        />
        {multiSelect ? (
          <Button size="sm" disabled={busy || (picked.length === 0 && !custom.trim())} className="h-8 shrink-0" onClick={submitMulti}>
            Submit
          </Button>
        ) : custom.trim() ? (
          <Button size="sm" disabled={busy} className="h-8 shrink-0" onClick={() => onResolve([custom.trim()])}>
            Send
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// Modern minimal chip surface — hairline border, no fills, no shadows.
function chipSurface(_dark: boolean, _inline: boolean): string {
  return 'min-w-0 max-w-full overflow-hidden border border-border bg-background hover:border-foreground/30 hover:bg-accent/40 transition-colors';
}

function ToolChip({ call, dark, inline = false }: { call: { id: string; name: string; input: any }; dark: boolean; inline?: boolean }) {
  const argPreview = useMemo(() => oneLineArg(call.input), [call.input]);
  return (
    <details className={`group rounded text-[11px] ${chipSurface(dark, inline)}`}>
      <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2 py-1 font-mono">
        <span className="text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{call.name}</span>
        {argPreview && <span className="text-muted-foreground truncate max-w-[32ch]">{argPreview}</span>}
      </summary>
      <pre className="mt-0 mx-0 border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap break-all bg-muted/40 text-foreground/80 rounded-b">
        {JSON.stringify(call.input, null, 2)}
      </pre>
    </details>
  );
}

function ToolBatchChip({ name, calls, dark, inline = false }: { name: string; calls: Array<{ id: string; name: string; input: any }>; dark: boolean; inline?: boolean }) {
  return (
    <details className={`group rounded text-[11px] ${chipSurface(dark, inline)}`}>
      <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2 py-1 font-mono">
        <span className="text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{name}</span>
        <span className="text-muted-foreground tabular-nums">× {calls.length}</span>
      </summary>
      <ul className="border-t border-border divide-y divide-border">
        {calls.map((c, i) => {
          const arg = oneLineArg(c.input);
          return (
            <li key={c.id || `${name}-${i}`} className="px-2 py-1 bg-muted/20">
              <details>
                <summary className="cursor-pointer list-none font-mono text-[11px] flex items-center gap-1.5">
                  <span className="text-muted-foreground/60 tabular-nums">{i + 1}.</span>
                  <span className="text-foreground/80 truncate">{arg || '(no arg)'}</span>
                </summary>
                <pre className="mt-1 px-2 py-1.5 rounded text-[10px] whitespace-pre-wrap break-all bg-muted/60 text-foreground/80">
                  {JSON.stringify(c.input, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function InlineToolResult({ block }: { block: { type: string; tool_use_id?: string; content?: any; is_error?: boolean } }) {
  const text = useMemo(() => extractToolResultText(block.content), [block.content]);
  const isError = !!block.is_error;
  return (
    <details className={cn(
      'min-w-0 max-w-full overflow-hidden rounded text-[11px] border bg-background transition-colors',
      isError
        ? 'border-rose-500/40 bg-rose-500/5'
        : 'border-border hover:border-foreground/30',
    )}>
      <summary className="cursor-pointer list-none px-2 py-1 font-mono flex items-center gap-1.5">
        <span className={isError ? 'text-rose-500' : 'text-muted-foreground/70'}>←</span>
        <span className="text-foreground/80">result</span>
        <span className="text-muted-foreground truncate max-w-[60ch]">{firstLine(text)}</span>
      </summary>
      <pre className="border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap break-all bg-muted/40 text-foreground/80 rounded-b">
        {text}
      </pre>
    </details>
  );
}

function InlineToolResultBatch({ results }: { results: Array<{ type: string; tool_use_id?: string; content?: any; is_error?: boolean }> }) {
  const errCount = results.filter((r) => r.is_error).length;
  const ok = errCount === 0;
  return (
    <details className={cn(
      'min-w-0 max-w-full overflow-hidden rounded text-[11px] border bg-background transition-colors',
      ok ? 'border-border hover:border-foreground/30' : 'border-rose-500/40 bg-rose-500/5',
    )}>
      <summary className="cursor-pointer list-none px-2 py-1 font-mono flex items-center gap-1.5">
        <span className={ok ? 'text-muted-foreground/70' : 'text-rose-500'}>←</span>
        <span className="text-foreground/80 tabular-nums">{results.length} results</span>
        {errCount > 0 && <span className="text-rose-500 tabular-nums">· {errCount} error{errCount > 1 ? 's' : ''}</span>}
      </summary>
      <div className="border-t border-border p-1.5 space-y-1 bg-muted/20 rounded-b">
        {results.map((b, i) => (
          <InlineToolResult key={i} block={b} />
        ))}
      </div>
    </details>
  );
}

function oneLineArg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  // Path-shaped fields get tail-truncation so the basename stays visible —
  // `…/long/path/foo.tsx` is more informative than `/Users/mac/…`.
  for (const k of ['file_path', 'path']) {
    if (typeof input[k] === 'string') return shortenPath(input[k]);
  }
  // URLs, commands, etc. stay head-anchored.
  for (const k of ['url', 'command', 'pattern', 'query', 'name', 'text']) {
    if (typeof input[k] === 'string') return shorten(input[k]);
  }
  // Fall back to first string value.
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return shorten(v);
  }
  return '';
}
function shorten(s: string, n = 60) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
// Keep file basename visible — chip width is small, and basename + nearest
// parent dir is what readers actually scan for. We pad with the parent dir
// when we have room (e.g. `…/components/markdown.tsx`).
function shortenPath(p: string, n = 48): string {
  if (p.length <= n) return p;
  const parts = p.split('/');
  const tail = parts.slice(-2).join('/');
  if (tail.length <= n - 1) return '…/' + tail;
  // Last segment alone is still too long — fall back to head trunc.
  return shorten(parts[parts.length - 1], n);
}
function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return shorten(i >= 0 ? s.slice(0, i) : s, 80);
}
function extractToolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content ?? {}, null, 2);
}
