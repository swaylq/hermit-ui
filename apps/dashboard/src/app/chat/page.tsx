'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, Suspense } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { RotateCw, Trash2, Terminal, Pencil, ListCollapse, Search, FoldVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { QUEUE_LIMIT } from '@/lib/chat-queue';
import { CtxBar } from '@/components/ctx-bar';
import { sessionStatusView } from '@/lib/session-status';
import { useMarkSessionRead } from '@/lib/session-read';
import { markSessionWorking } from '@/lib/session-live';
import { authedFetch } from '@/lib/asst-fetch';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { useScope } from '@/lib/use-scope';
import { LoopBar } from '@/components/chat/loop-bar';
import { msgText, isHarnessTerminator, type Attachment } from '@/components/chat/lib';
import { ChatFind } from '@/components/chat/chat-find';
import { NewChatPane } from '@/components/chat/new-chat-pane';
import { ConfirmIconButton } from '@/components/chat/confirm-icon-button';
import { EmptyChat } from '@/components/chat/empty-chat';
import { TypingIndicator } from '@/components/chat/message-bits';
import { MessageTimeline } from '@/components/chat/message-timeline';
import { ComposeBar, QueueBar } from '@/components/chat/composer';

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
          const res = await authedFetch(`/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}${isReconnect ? '' : '&skipInitial=1'}`, {
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
            onConfirm={() => { restartSession.mutate({ id: sessionId }); }}
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

        <>
          <LoopBar
            loopState={(session as { loopState?: unknown } | undefined)?.loopState}
            onStartLoop={() => pickPrompt(LOOP_TEMPLATE)}
            onStartCron={() => pickPrompt(CRON_TEMPLATE)}
            onStartAutonomy={() => pickPrompt(AUTONOMY_TEMPLATE)}
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
    </>
  );
}

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

// One-shot autonomy nudge (NOT a recurring task): tells the agent to proceed with
// its own recommendation and stop asking for confirmation until the work is done.
// Dropped by the "Run to done" suggestion — no cadence, so it doesn't trip the
// loop/cron skills; it's a plain directive for the current task.
const AUTONOMY_TEMPLATE = '按照你的推荐做，不再询问我，直到做完。';
