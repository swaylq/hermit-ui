'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo, type ChangeEvent, type ClipboardEvent, type DragEvent, Suspense } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, ArrowUp, FileText, RotateCw, Trash2, X, Terminal, Pencil, ListCollapse, Search, FoldVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { QUEUE_LIMIT } from '@/lib/chat-queue';
import { relTime } from '@/lib/format';
import { ImageLightbox } from '@/components/ui/image-lightbox';
import { isTouchPrimary } from '@/lib/save-file';
import { CtxBar } from '@/components/ctx-bar';
import { sessionStatusView } from '@/lib/session-status';
import { useMarkSessionRead } from '@/lib/session-read';
import { markSessionWorking } from '@/lib/session-live';
import { TimeAgo } from '@/components/time-ago';
import { getActiveKey } from '@/app/providers';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { useScope } from '@/lib/use-scope';
import { ToolChip, ToolBatchChip, InlineToolResult, InlineToolResultBatch } from '@/components/chat/tool-chips';
import { InteractionCard } from '@/components/chat/interaction-card';
import { ChatImage, ChatFile } from '@/components/chat/file-preview';
import { LoopBar } from '@/components/chat/loop-bar';
import { msgText, isSameDay } from '@/components/chat/lib';
import { ChatFind } from '@/components/chat/chat-find';
import { NewChatPane } from '@/components/chat/new-chat-pane';
import { ConfirmIconButton } from '@/components/chat/confirm-icon-button';
import { EmptyChat } from '@/components/chat/empty-chat';
import { StreamingDots, TypingIndicator, TypedText, DateDivider } from '@/components/chat/message-bits';
import { RestartBar } from '@/components/chat/restart-bar';

type Block = { type: string; text?: string; name?: string; input?: any; tool_use_id?: string; content?: any; source?: any; width?: number; height?: number };

// In-flight or finished upload attached to the composer (image or generic file).
// `previewUrl` is an object-URL thumbnail for images, null for non-image files.
type Attachment =
  | { id: string; kind: 'uploading'; name: string; isImage: boolean; previewUrl: string | null }
  | { id: string; kind: 'ready'; name: string; isImage: boolean; previewUrl: string | null; data: { url: string; mimeType: string; width: number | null; height: number | null } }
  | { id: string; kind: 'error'; name: string; error: string };

// isTouchPrimary (phone/tablet vs desktop) lives in @/lib/save-file — the
// soft-keyboard return key inserts a newline there (a dedicated send button
// handles sending), and the same gate drives the share-vs-download save path.

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
  const scope = useScope();

  // agents.list is machine-wide (403 in a scoped share session) — disable it
  // there; a scoped new-chat is locked to the shared agent and needs no list.
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000, enabled: !scope.scoped });
  // No own refetchInterval — the always-mounted sidebar already polls
  // listSessions every 5s; this shares that cache (used here only for the
  // landing redirect + empty state). Drops a duplicate 5s poll/re-render.
  const sessions = trpc.chat.listSessions.useQuery({});

  // Selection is URL-driven (?session=<id>); the global app sidebar owns the
  // session list + New chat. When nothing is selected and we're not composing a
  // new chat, land on the most recent session so the area is never blank.
  useEffect(() => {
    if (sessionParam) return;
    // Scoped share session: the link drops you at /chat?agent=X. Default into the
    // most recent EXISTING chat with the agent; only show the new-chat compose
    // when there are none, or when New chat was explicitly clicked (?new=1).
    if (scope.scoped) {
      if (search.get('new')) return;
      const recent = (sessions.data ?? []).find((s) => !s.hiddenAt && s.origin !== 'dispatch');
      if (recent) window.location.href = `/chat?session=${encodeURIComponent(recent.id)}`;
      return;
    }
    if (showNew) return;
    // Skip the orchestrator (Brain) — its chats live only in /brain, never the
    // dashboard. (listSessions still returns them; we just never land on one.)
    const brainName = agents.data?.find((a) => a.isOrchestrator)?.name;
    // Also skip hidden sessions (the user decluttered them) and Brain's dispatch
    // sessions (origin:'dispatch' — those live only in /brain/dispatch).
    const first = (sessions.data ?? []).find((s) => s.agentName !== brainName && !s.hiddenAt && s.origin !== 'dispatch');
    if (first) router.replace(`/chat?session=${encodeURIComponent(first.id)}`);
  }, [showNew, sessionParam, sessions.data, agents.data, router, scope.scoped, search]);

  if (showNew) {
    return (
      <NewChatPane
        agents={(agents.data ?? []).map((a) => a.name)}
        preset={agentParam ?? undefined}
        lockedAgent={scope.scoped ? scope.agentName ?? undefined : undefined}
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

export function SessionPane({ sessionId }: { sessionId: string }) {
  const utils = trpc.useUtils();
  const scope = useScope();
  // Poll on our own heartbeat instead of free-riding the sidebar's listSessions
  // query: the sidebar's RecentSessions only mounts when the sidebar is expanded
  // AND on /chat, so on mobile (off-canvas drawer, unmounted) or a collapsed
  // sidebar nothing refetched this — the header status chip / context counter
  // froze at page-load value until you touched the sidebar. Same query key as the
  // sidebar, so React Query shares the cache (no double payload when both mount).
  const sessionMeta = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });
  // Fast early paint: a single-row getSession resolves the header + enables the
  // composer in tens of ms, instead of waiting on listSessions (~0.5–0.9s for 40
  // sessions × a per-row preview subquery) — which otherwise leaves the title
  // showing the raw id and the composer disabled. Once the list loads it takes
  // over (every existing sessionMeta.refetch keeps the header fresh), so this is
  // just the gap-filler and one fetch suffices (staleTime, no extra polling).
  const sessionOne = trpc.chat.getSession.useQuery({ sessionId }, { enabled: !!sessionId, staleTime: 30_000 });
  const session = sessionMeta.data?.find((s) => s.id === sessionId) ?? sessionOne.data ?? undefined;
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
    let reconnectTimer: number | null = null;
    let attempts = 0;              // consecutive (re)connect attempts → backoff index
    let started = false;           // first connect skips the initial emit; reconnects don't
    let lastActivity = Date.now(); // last byte (data OR 15s ping) seen on the stream

    // Server pings every 15s; if nothing arrives for this long the connection is a
    // silently-dropped zombie (half-open TCP after sleep / network switch / proxy
    // idle-kill) — reader.read() hangs forever with streamConnected still true,
    // freezing the chat AND suppressing the fallback poll. Abort → reconnect.
    const IDLE_DEAD_MS = 35_000;
    const BACKOFFS = [1_000, 2_000, 5_000];

    // Function decl (not const arrow) so the reconnect in `finally` can self-refer.
    function connect() {
      if (cancelled || document.hidden || ctrl) return; // hidden, or already streaming
      const myCtrl = new AbortController();
      ctrl = myCtrl;
      const isReconnect = started;
      started = true;
      lastActivity = Date.now();
      // Optimistically mark connected the instant we START connecting, so the
      // fallback poll (refetchInterval — 600ms during an active turn) does NOT
      // hammer the server with redundant full-window listMessages refetches
      // during the SSE handshake. A slow first connect otherwise fires several
      // ~150KB fetches that pile up and inflate each other's TTFB (measured: 4
      // fetches at open, server TTFB climbing 96→1059ms). Any failure/disconnect
      // resets it in the finally/disconnect below, re-enabling the real fallback.
      setStreamConnected(true);
      (async () => {
        try {
          // Initial connect skips the initial emit — listMessages already loaded
          // this window (avoids the open-time double-fetch). A RECONNECT does NOT
          // skip: it emits the current window once to catch up on anything that
          // landed during the disconnect gap.
          const res = await fetch(`/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}${isReconnect ? '' : '&skipInitial=1'}`, {
            headers: { 'x-asst-key': getActiveKey() },
            signal: myCtrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          setStreamConnected(true);
          lastActivity = Date.now();
          attempts = 0; // a good connect resets the backoff
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            lastActivity = Date.now(); // any byte — data frame OR keep-alive ping
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
          /* network error / abort / zombie-kill — reconnect below takes over */
        } finally {
          if (ctrl === myCtrl) ctrl = null;
          if (!cancelled) {
            setStreamConnected(false);
            // Reconnect with backoff so a transient drop restores instant push
            // instead of degrading to the 2s fallback poll forever. Skipped while
            // hidden — onVisibility reconnects on return.
            if (!document.hidden && reconnectTimer == null) {
              const delay = BACKOFFS[Math.min(attempts, BACKOFFS.length - 1)];
              attempts += 1;
              reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect(); }, delay);
            }
          }
        }
      })();
    }

    const disconnect = () => {
      if (reconnectTimer != null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      const c = ctrl;
      ctrl = null;
      c?.abort();
      setStreamConnected(false);
    };

    // Zombie watchdog: abort a connection gone silent past IDLE_DEAD_MS so the
    // finally schedules a reconnect. Cheap — a timestamp compare every 10s, no
    // network; in steady state the 15s ping keeps lastActivity fresh so it's a no-op.
    const watchdog = window.setInterval(() => {
      if (!document.hidden && ctrl && Date.now() - lastActivity > IDLE_DEAD_MS) ctrl.abort();
    }, 10_000);

    // Pause the stream while the tab is hidden: otherwise a backgrounded chat keeps
    // the server polling Postgres every POLL_MS indefinitely. Reopen (and catch up)
    // on return. (The fallback listMessages poll is already paused in the background
    // by react-query's refetchIntervalInBackground:false default.)
    const onVisibility = () => {
      if (document.hidden) disconnect();
      else { attempts = 0; connect(); }
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(watchdog);
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      ctrl?.abort();
      setStreamConnected(false);
    };
  }, [sessionId, limit, utils]);

  const send = trpc.chat.send.useMutation({
    onSuccess: () => {
      utils.chat.listMessages.invalidate({ sessionId });
      utils.chat.listSessions.invalidate();
      utils.chat.queue.invalidate({ sessionId });
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
  const dequeue = trpc.chat.dequeue.useMutation({
    onSuccess: () => {
      utils.chat.queue.invalidate({ sessionId });
      utils.chat.listMessages.invalidate({ sessionId }); // the cancelled bubble leaves the timeline too
    },
  });
  const clearQueue = trpc.chat.clearQueue.useMutation({
    onSuccess: () => {
      utils.chat.queue.invalidate({ sessionId });
      utils.chat.listMessages.invalidate({ sessionId });
    },
  });

  const [draft, setDraft] = useState(() => loadDraft(sessionId));
  // Persist the draft per session (localStorage writes are cheap for short
  // text). Auto-cleared when the draft empties on send / Escape.
  useEffect(() => { saveDraft(sessionId, draft); }, [sessionId, draft]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Composer notice line: attachment-cap warnings (set in ComposeBar.addFiles) AND
  // send failures (set in onSend's onError) — so a rejected send explains itself
  // instead of silently restoring the draft.
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
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
  // The waiting dispatch queue (undelivered user rows). Refetch only while it
  // matters: the gateway drains as turns end (so poll while in-flight) and the
  // user can cancel (so poll while non-empty); idle + empty → off. Mutations
  // invalidate for instant feedback.
  const queue = trpc.chat.queue.useQuery(
    { sessionId },
    { refetchInterval: (q) => (isInFlight || (q.state.data?.length ?? 0) > 0 ? 2_000 : false) },
  );
  // A message sent while NO prior turn is in flight is the imminent ACTIVE turn,
  // not a queued item — yet it lingers in queue.data (deliveredAt=null) for the
  // ~2s until the gateway picks it up, so it would flash through the QueueBar.
  // Capture each such id at send time (see onSend's `wasIdle`) and hide them: the
  // QueueBar should only show messages waiting BEHIND an in-flight turn.
  // - A Set, not a single id, so two quick sends to an idle pane don't expose the
  //   first when the second's id overwrites it.
  // - Keyed on isWaitingAssistant (a delivered, still-unanswered message), NOT the
  //   broader isInFlight: isInFlight also counts streamingTailId's ~1.8s decay tail
  //   that lingers after a reply visibly ends, which used to misclassify a quick
  //   reply-after-reply send as "queued" and flash it. That was the stutter.
  // Pruned to delivered-only by the effect below so it can't grow unbounded.
  const [starterIds, setStarterIds] = useState<Set<string>>(() => new Set());
  // Optimistic queue overlay: a message sent while a turn is running IS a queue
  // item, but the real row only surfaces after the ~2s queue poll. Stubs pushed
  // here on send (see onSend) show instantly; pruned when the real queued row
  // lands (effect below, keyed on queue.data) or on send error. Deduped by text
  // against the real queue so the hand-off doesn't double-count.
  const [optimisticQueue, setOptimisticQueue] = useState<Array<{ id: string; content: { type: 'text'; text: string }[] }>>([]);
  const realQueue = (queue.data ?? []).filter((m) => !starterIds.has(m.id));
  const realQueueTexts = new Set(realQueue.map((m) => msgText(m.content)));
  const displayQueue = [
    ...realQueue,
    ...optimisticQueue.filter((p) => !realQueueTexts.has(msgText(p.content))),
  ];
  const queueLen = displayQueue.length;
  // Messages you've typed this session, oldest→newest — the ↑/↓ recall history in
  // the composer. msgText is empty for tool_result rows (gateway-synced role:user),
  // so this captures only your own text sends.
  const sentHistory = useMemo(
    () => (messages.data ?? []).filter((m) => m.role === 'user').map((m) => msgText(m.content)).filter(Boolean),
    [messages.data],
  );
  // Drop an optimistic queue stub once the real queued row lands in queue.data, so
  // it can't reappear after the message is delivered (and leaves queue.data).
  useEffect(() => {
    if (optimisticQueue.length === 0) return;
    const queued = new Set((queue.data ?? []).map((m) => msgText(m.content)));
    setOptimisticQueue((q) => {
      const next = q.filter((x) => !queued.has(msgText(x.content)));
      return next.length === q.length ? q : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data]);
  // Drop starter ids once their message has been delivered (left queue.data), so
  // the Set stays bounded across a long session. A still-undelivered starter stays
  // hidden; an id no longer in the queue is gone for good.
  useEffect(() => {
    if (starterIds.size === 0) return;
    const live = new Set((queue.data ?? []).map((m) => m.id));
    setStarterIds((s) => {
      const next = new Set([...s].filter((id) => live.has(id)));
      return next.size === s.size ? s : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data]);
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
  // sidebar / agent-detail views (on any device) once we've seen the latest.
  const markRead = useMarkSessionRead();
  useEffect(() => {
    markRead(sessionId);
  }, [markRead, sessionId, messages.data?.length, isInFlight]);

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
                    // Ignore the Enter that confirms an IME candidate (输入法组字中回车)
                    // — same guard as the composer, so it doesn't submit mid-composition.
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
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
              {/* Agent name is hidden on mobile (sidebar / session list already
                  shows it) to keep the cramped header clean; its leading
                  separator hides with it so status doesn't start with an orphan "·". */}
              <span className="hidden sm:inline text-foreground/70">{session?.agentName}</span>
              {session && (
                <>
                  <span className="hidden sm:inline text-muted-foreground/40">·</span>
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
          {!scope.scoped && (
            <Link
              href={`/chat/terminal?session=${encodeURIComponent(sessionId)}`}
              title="attach to this session's tmux pane"
              aria-label="terminal access"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
            >
              <Terminal className="h-4 w-4" />
            </Link>
          )}
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
            sessionId={sessionId}
          />
          <QueueBar
            items={displayQueue}
            onCancel={(id) => {
              // A still-optimistic stub isn't a real DB row yet — drop it locally;
              // a real queued row goes through the dequeue mutation.
              if (id.startsWith('pending-')) setOptimisticQueue((q) => q.filter((x) => x.id !== id));
              else dequeue.mutate({ messageId: id });
            }}
            onClear={() => { setOptimisticQueue([]); clearQueue.mutate({ sessionId }); }}
            clearing={clearQueue.isPending}
          />
          <ComposeBar
            sessionId={sessionId}
            disabled={!!session?.closedAt}
            awaitingInput={!!pendingInteraction}
            sending={send.isPending}
            inFlight={isInFlight}
            queueFull={queueLen >= QUEUE_LIMIT}
            stopping={cancelTurn.isPending}
            onStop={() => cancelTurn.mutate({ sessionId })}
            onSend={(text, images, files) => {
              // Sending always re-pins to the bottom (even if the user had
              // scrolled up) so their message + the reply scroll into view.
              scrollToBottom('auto');
              setComposerNotice(null); // clear any stale cap/error notice on a fresh send
              // Is a prior turn already in flight BEFORE this send? If not, this
              // message IS the imminent active turn (not a queue item) — record it
              // so the QueueBar doesn't flash it while the gateway picks it up (see
              // starterIds). Gate on isWaitingAssistant, NOT isInFlight: the latter
              // also counts streamingTailId's ~1.8s decay tail, so a quick send
              // right after a reply visibly ends was misread as "queued" and
              // stuttered through the QueueBar before being pushed out.
              const wasIdle = !isWaitingAssistant;
              // Optimistically flip this session's sidebar dot to "working" the
              // instant we send — the gateway snapshot that sets the real `state`
              // is ~8s behind. The sidebar reconciles it against snapshotAt and it
              // auto-expires; the header already shows working via isInFlight.
              markSessionWorking(sessionId);
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
                // A send while a turn is already running IS a queue item — show it
                // in the QueueBar instantly instead of waiting for the ~2s poll.
                if (!wasIdle) {
                  setOptimisticQueue((q) => [...q, { id: optimisticId, content: [{ type: 'text', text }] }]);
                }
              }
              setDraft('');
              setAttachments([]);
              send.mutate(
                { sessionId, text, images, files },
                {
                  onSuccess: (msg) => {
                    if (wasIdle) setStarterIds((s) => { const n = new Set(s); n.add(msg.id); return n; });
                  },
                  onError: (err) => {
                    setPending((p) => p.filter((x) => x.id !== optimisticId));
                    setOptimisticQueue((q) => q.filter((x) => x.id !== optimisticId));
                    setDraft(prevDraft);
                    setAttachments(prevAttachments);
                    // Surface WHY (e.g. over the image cap) instead of silently
                    // restoring the draft — the old behavior read as "send is dead".
                    setComposerNotice(err.message || 'Failed to send — please try again.');
                  },
                },
              );
            }}
            draft={draft}
            setDraft={setDraft}
            attachments={attachments}
            setAttachments={setAttachments}
            notice={composerNotice}
            setNotice={setComposerNotice}
            taRef={taRef}
            history={sentHistory}
          />
        </>
      )}
    </>
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
  // mcp__hermit__ask renders its InteractionCard at the tool_use call site (see
  // groupConsecutiveTools). Build a question→interaction-block map from the
  // separately-synced system messages, and suppress those standalone system
  // cards when a matching ask tool_use is in the window — the system row is
  // created (by the MCP stub) BEFORE the assistant turn's blocks finish syncing,
  // so it gets an earlier id and would otherwise sort ABOVE the question text
  // instead of beside it.
  const askCardByQuestion = new Map<string, any>();
  const askedQuestions = new Set<string>();
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as any[]) : [];
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b?.name === 'mcp__hermit__ask' && typeof b?.input?.question === 'string') {
        askedQuestions.add(b.input.question);
      } else if (b?.type === 'interaction' && (b?.kind ?? 'question') === 'question' && typeof b?.payload?.question === 'string') {
        askCardByQuestion.set(b.payload.question, b);
      }
    }
  }
  const visibleMessages = messages.filter((m) => {
    if (m.role !== 'system') return true;
    const blocks = Array.isArray(m.content) ? (m.content as any[]) : [];
    if (blocks.length === 0 || !blocks.every((b) => b?.type === 'interaction')) return true;
    // Drop only if EVERY interaction block is a question whose ask tool_use is
    // in the window (the call site renders the card); otherwise keep it.
    return !blocks.every((b) => (b?.kind ?? 'question') === 'question' && askedQuestions.has(b?.payload?.question));
  });

  const out: React.ReactNode[] = [];
  let prevDay: Date | string | null = null;
  let i = 0;
  while (i < visibleMessages.length) {
    const m = visibleMessages[i];
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
      while (j < visibleMessages.length) {
        const nb = visibleMessages[j].content as Block[];
        const nIsToolResultOnly = nb.length > 0 && nb.every((b) => b.type === 'tool_result');
        if (!nIsToolResultOnly) break;
        if (!isSameDay(prevDay!, visibleMessages[j].createdAt)) break;
        combined.push(...nb);
        lastId = visibleMessages[j].id;
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
      const isLast = i === visibleMessages.length - 1;
      const typing = isLast && m.role === 'assistant' && Date.now() - new Date(m.createdAt).getTime() < 8_000;
      out.push(<MessageRow key={m.id} role={m.role} content={blocks} ts={m.createdAt} streamingTail={streamingTail} typing={typing} streamingDot={streamingTail ? dotClass : undefined} askCardByQuestion={askCardByQuestion} />);
      i += 1;
    }
  }
  return <div className="space-y-3">{out}</div>;
});

// Claude Code built-in slash commands the composer suggests when the user
// types "/". Picking one fills the draft; sending sends it as a normal user
// message — it lands in the agent's REPL via tmux send-keys and claude runs
// it just like a typed slash command. Interactive ones (/help, /memory, etc.)
// are intentionally omitted: they open TUI modals that hang the headless pane.
const SLASH_COMMANDS: Array<{ name: string; hint: string; needsArgs?: boolean }> = [
  { name: '/compact',  hint: '压缩上下文' },
  { name: '/clear',    hint: '清空对话' },
  { name: '/status',   hint: '当前会话状态' },
  { name: '/model',    hint: '切换模型（如 opus / sonnet / fable）', needsArgs: true },
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

// The waiting-dispatch queue strip, shown between the LoopBar and the composer
// whenever messages are queued behind the in-flight turn. Each item can be
// pulled (✕ → dequeue) before the gateway sends it; "清空队列" empties the lot.
// Reuses the module-scope msgText to render a one-line preview.
function QueueBar({
  items,
  onCancel,
  onClear,
  clearing,
}: {
  items: Array<{ id: string; content: unknown }>;
  onCancel: (id: string) => void;
  onClear: () => void;
  clearing: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between text-muted-foreground">
          <span>{items.length} 条排队中 · 等当前任务完成后依次执行</span>
          <button
            type="button"
            onClick={onClear}
            disabled={clearing}
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 cursor-pointer"
          >
            清空队列
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={it.id} className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 tabular-nums text-muted-foreground/60">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">{msgText(it.content) || '（附件）'}</span>
              <button
                type="button"
                onClick={() => onCancel(it.id)}
                aria-label="cancel queued message"
                title="移出队列"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ComposeBar({
  sessionId,
  disabled,
  awaitingInput = false,
  sending,
  inFlight,
  queueFull,
  stopping,
  onStop,
  draft,
  setDraft,
  attachments,
  setAttachments,
  notice,
  setNotice,
  onSend,
  taRef,
  history,
}: {
  sessionId: string;
  disabled: boolean;
  awaitingInput?: boolean;
  sending: boolean;
  inFlight: boolean;
  queueFull: boolean;
  stopping: boolean;
  onStop: () => void;
  draft: string;
  setDraft: (s: string) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  notice: string | null;
  setNotice: (s: string | null) => void;
  onSend: (
    text: string,
    images: Array<{ url: string; mimeType: string; width: number | null; height: number | null }>,
    files: Array<{ url: string; mimeType: string; name: string }>,
  ) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  history: string[];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Shell-style sent-message recall: histIdxRef walks `history` (newest last;
  // -1 = the live draft). liveDraftRef stashes what you were typing before you
  // started browsing, so ↓ past the newest restores it.
  const histIdxRef = useRef(-1);
  const liveDraftRef = useRef('');
  const recall = useCallback((text: string) => {
    setDraft(text);
    // setDraft is programmatic here (no onChange fires) — move the caret to the
    // end and re-fit the height ourselves, after the new value paints.
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.selectionStart = el.selectionEnd = el.value.length;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
    });
  }, [setDraft, taRef]);

  // Auto-resize textarea: clamp height between 1 and 12 rows.
  const onChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    histIdxRef.current = -1; // typing detaches from history browsing
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
  const addFiles = useCallback(async (incoming: File[]) => {
    if (incoming.length === 0) return;
    // Enforce the per-message caps up front so extras are skipped with a visible
    // notice — instead of being accepted and then silently sinking the whole send
    // (chat.send rejects if images > MAX_IMAGES or files > MAX_FILES). Count slots
    // already taken (ready or still uploading; error chips don't occupy one).
    const liveImg = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && a.isImage).length;
    const liveFile = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && !a.isImage).length;
    let imgSlots = MAX_IMAGES - liveImg;
    let fileSlots = MAX_FILES - liveFile;
    const accepted: File[] = [];
    let droppedImg = 0;
    let droppedFile = 0;
    for (const file of incoming) {
      if (file.type.startsWith('image/')) {
        if (imgSlots > 0) { accepted.push(file); imgSlots -= 1; } else droppedImg += 1;
      } else if (fileSlots > 0) { accepted.push(file); fileSlots -= 1; } else {
        droppedFile += 1;
      }
    }
    if (droppedImg || droppedFile) {
      const parts: string[] = [];
      if (droppedImg) parts.push(`${droppedImg} image${droppedImg > 1 ? 's' : ''} (max ${MAX_IMAGES} per message)`);
      if (droppedFile) parts.push(`${droppedFile} file${droppedFile > 1 ? 's' : ''} (max ${MAX_FILES} per message)`);
      setNotice(`Skipped ${parts.join(' and ')}.`);
    } else {
      setNotice(null);
    }
    if (accepted.length === 0) return;
    for (const file of accepted) {
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
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-asst-key': getActiveKey() }, body: fd });
        if (!r.ok) throw new Error(`upload failed (${r.status}): ${await r.text().catch(() => '')}`);
        const data = await r.json() as { url: string; mimeType: string; width: number | null; height: number | null };
        const clientDims = await clientDimsP;
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'ready', name, isImage, previewUrl, data: { url: data.url, mimeType: data.mimeType, width: data.width ?? clientDims?.width ?? null, height: data.height ?? clientDims?.height ?? null } } : a));
      } catch (e) {
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'error', name, error: e instanceof Error ? e.message : String(e) } : a));
      }
    }
  }, [sessionId, setAttachments, attachments, setNotice]);

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
  // Occupied slots (ready or uploading; error chips don't count) for the caps caption.
  const imgCount = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && a.isImage).length;
  const fileCount = attachments.filter((a) => (a.kind === 'ready' || a.kind === 'uploading') && !a.isImage).length;

  const submit = () => {
    const text = draft.trim();
    if (sending || disabled || queueFull) return;
    // Hold the send until every attachment finishes uploading — otherwise the
    // message goes out with the still-uploading files silently dropped.
    if (uploadingCount > 0) return;
    if (!text && readyAttachments.length === 0) return;
    const images = readyAttachments
      .filter((a) => a.isImage)
      .map((a) => ({ url: a.data.url, mimeType: a.data.mimeType, width: a.data.width, height: a.data.height }));
    const files = readyAttachments
      .filter((a) => !a.isImage)
      .map((a) => ({ url: a.data.url, mimeType: a.data.mimeType, name: a.name }));
    onSend(text, images, files);
    histIdxRef.current = -1;
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
  const canSend = !sending && !disabled && !awaitingInput && !queueFull && uploadingCount === 0 && (draft.trim().length > 0 || readyAttachments.length > 0);

  return (
    <form
      className={cn('shrink-0 bg-background transition-colors', dragHover && 'bg-accent/30')}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* pwa-pb-safe: in the installed PWA, the composer's bottom padding grows to
          clear the home indicator (absorbed via max(), not stacked) so the input
          sits snug above it with no empty band. No-op in a normal browser tab. */}
      <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-1 pwa-pb-safe">
        {notice && (
          <button
            type="button"
            onClick={() => setNotice(null)}
            title="dismiss"
            className="mb-2 flex w-full items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-left text-[12px] text-amber-700 dark:text-amber-400 cursor-pointer"
          >
            <span className="flex-1">{notice}</span>
            <X className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        )}
        {attachments.length > 0 && (
          <div className="mb-2 space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
              ))}
            </div>
            {(imgCount > 0 || fileCount > 0) && (
              <div className="px-0.5 text-[11px] tabular-nums text-muted-foreground/60">
                {imgCount > 0 && (
                  <span className={cn(imgCount >= MAX_IMAGES && 'text-amber-600 dark:text-amber-400')}>{imgCount}/{MAX_IMAGES} images</span>
                )}
                {imgCount > 0 && fileCount > 0 && <span> · </span>}
                {fileCount > 0 && (
                  <span className={cn(fileCount >= MAX_FILES && 'text-amber-600 dark:text-amber-400')}>{fileCount}/{MAX_FILES} files</span>
                )}
              </div>
            )}
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
              disabled={disabled || awaitingInput}
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
              // Shell-style history recall: ↑ on the first line walks back through
              // the messages you've sent this session; ↓ on the last line walks
              // forward, then restores the draft you were typing. (The slash picker
              // claims ↑/↓ above when open; skip during IME composition.)
              if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing && history.length > 0) {
                const ta = e.currentTarget;
                const onFirstLine = !draft.slice(0, ta.selectionStart ?? 0).includes('\n');
                const onLastLine = !draft.slice(ta.selectionEnd ?? draft.length).includes('\n');
                if (e.key === 'ArrowUp' && onFirstLine) {
                  e.preventDefault();
                  if (histIdxRef.current === -1) liveDraftRef.current = draft;
                  histIdxRef.current = Math.min(histIdxRef.current + 1, history.length - 1);
                  recall(history[history.length - 1 - histIdxRef.current]);
                  return;
                }
                if (e.key === 'ArrowDown' && onLastLine && histIdxRef.current >= 0) {
                  e.preventDefault();
                  histIdxRef.current -= 1;
                  recall(histIdxRef.current < 0 ? liveDraftRef.current : history[history.length - 1 - histIdxRef.current]);
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
                : queueFull
                ? `queue full (${QUEUE_LIMIT}) · waiting for current turn`
                : showStop
                ? 'working… ↵ to queue next'
                : uploadingCount > 0
                ? `uploading ${uploadingCount}…`
                : 'Ask anything'
            }
            disabled={disabled || awaitingInput}
            rows={1}
            className="flex-1 bg-transparent text-base sm:text-[15px] resize-none outline-none leading-relaxed min-h-[28px] max-h-[360px] overflow-auto py-1.5 text-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
          />

          {/* Clear the draft once there's text — mirrors the x on the other inputs. */}
          {draft.length > 0 && !disabled && (
            <button
              type="button"
              onClick={() => { setDraft(''); taRef.current?.focus(); }}
              aria-label="clear draft"
              title="Clear"
              className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          )}

          {showStop && (
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
          )}
          {(!showStop || canSend) && (
            <button
              type="submit"
              disabled={!canSend}
              className={cn(
                'h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-all',
                canSend
                  ? 'bg-foreground text-background hover:bg-foreground/90 cursor-pointer shadow-sm'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
              aria-label={inFlight ? 'queue message' : 'send'}
              title={inFlight ? 'queue (↵)' : canSend ? 'send (↵)' : uploadingCount > 0 ? 'uploading…' : 'type a message'}
            >
              {sending ? <span className="text-sm">…</span> : <ArrowUp className="h-5 w-5" />}
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50 hidden sm:block">
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
  // office docs — converted agent-side via Bash (textutil / python / unzip)
  'docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp',
  // audio — stored as-is; the agent transcribes / inspects via Bash (whisper / ffmpeg)
  'mp3','m4a','wav','ogg','flac','aac',
  // video — stored as-is; the agent inspects / extracts frames / transcribes via Bash (ffmpeg / ffprobe)
  'mp4','mov','m4v','webm','mkv','avi','mpeg','mpg','3gp','wmv',
] as const;
const SAFE_FILE_EXT_SET = new Set<string>(SAFE_FILE_EXTS);
// `<input accept>` value: `image/*` + every whitelisted file extension.
const FILE_ACCEPT = 'image/*,' + SAFE_FILE_EXTS.map((e) => '.' + e).join(',');

// Per-message attachment caps — MUST match the server's chat.send zod .max(...).
// The composer enforces them so extras are skipped with a visible notice instead of
// silently failing the send (chat.send rejects the whole message if either is over).
const MAX_IMAGES = 20;
const MAX_FILES = 10;

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
  const [lightbox, setLightbox] = useState(false);
  return (
    <div className="relative group inline-flex items-center gap-2 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] font-mono">
      {previewUrl ? (
        <button type="button" onClick={() => setLightbox(true)} aria-label="preview image" className="shrink-0 cursor-zoom-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={a.name} className={cn(
            'h-10 w-10 rounded object-cover',
            a.kind === 'uploading' && 'opacity-50',
            a.kind === 'error' && 'opacity-30 grayscale',
          )} />
        </button>
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
      {previewUrl && <ImageLightbox open={lightbox} onOpenChange={setLightbox} url={previewUrl} alt={a.name} />}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ role, content, ts, streamingTail = false, typing = false, streamingDot, askCardByQuestion }: { role: string; content: Block[]; ts: Date | string; streamingTail?: boolean; typing?: boolean; streamingDot?: string; askCardByQuestion?: Map<string, any> }) {
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
  const grouped = groupConsecutiveTools(content, askCardByQuestion);
  const hasVisibleText = content.some((b) => b.type === 'text' && (b as any).text?.trim());

  // Interaction cards (permission / question prompts) carry their own border +
  // controls — render full-width & centered regardless of which message hosts
  // them: a standalone system row, OR an mcp__hermit__ask tool_use we swapped
  // for the card at its call site (so it sits beside the question text, not in
  // an assistant bubble). Must precede the role-specific branches below.
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
    // (Interaction cards are handled by the role-agnostic branch above.)
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
            <TimeAgo date={ts} />
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

function groupConsecutiveTools(blocks: Block[], askCardByQuestion?: Map<string, any>): Group[] {
  const out: Group[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text) out.push({ kind: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      const t = (b as any).thinking ?? (b as any).text;
      if (t) out.push({ kind: 'thinking', text: String(t) });
    } else if (b.type === 'tool_use') {
      // mcp__hermit__ask IS the question prompt — render the interactive
      // InteractionCard right here at the call site instead of the raw tool
      // JSON. The card is matched (by question text) to the separately-synced
      // system interaction message, which carries the interactionId/status the
      // buttons need. Falls back to the raw call if that block isn't in the
      // loaded window. (The standalone system card is suppressed in
      // MessageTimeline so the card shows once, anchored beside the question —
      // it otherwise sorts ABOVE the question text, see the suppression note.)
      const askQ = (b as any).name === 'mcp__hermit__ask' ? (b as any).input?.question : undefined;
      const askCard = typeof askQ === 'string' ? askCardByQuestion?.get(askQ) : undefined;
      if (askCard) { out.push({ kind: 'interaction', block: askCard }); continue; }
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

function GroupView({ group, dark, inline = false, typing = false }: { group: Group; dark: boolean; inline?: boolean; typing?: boolean }) {
  if (group.kind === 'text') return <TypedText text={group.text} typing={typing} />;
  if (group.kind === 'image') {
    return <ChatImage url={group.url} width={group.width} height={group.height} />;
  }
  if (group.kind === 'file') {
    return <ChatFile url={group.url} name={group.name} mimeType={group.mimeType} />;
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
