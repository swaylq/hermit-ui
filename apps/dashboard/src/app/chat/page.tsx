'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, Suspense, lazy } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  RotateCw, Trash2, Terminal, Pencil, ListCollapse, Search, FoldVertical, Sparkles,
  MoreHorizontal, ChevronRight, SquarePen, Info, ArchiveRestore,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { QUEUE_LIMIT } from '@/lib/chat-queue';
import { CtxBar } from '@/components/ctx-bar';
import { contextWindowFor } from '@/lib/context-window';
import { sessionStatusView } from '@/lib/session-status';
import { useMarkSessionRead } from '@/lib/session-read';
import { lastSessionId, rememberSession } from '@/lib/last-session';
import { markSessionWorking } from '@/lib/session-live';
import { authedFetch } from '@/lib/asst-fetch';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { useScope } from '@/lib/use-scope';
import { LoopBar } from '@/components/chat/loop-bar';
import { TakeoverBar } from '@/components/chat/takeover-bar';
import { msgText, isHarnessTerminator, type Attachment } from '@/components/chat/lib';
import { ChatFind } from '@/components/chat/chat-find';
import { useAnchoredWindow } from '@/components/chat/use-anchored-window';
import { useOlderPages } from '@/components/chat/use-older-pages';
import { usePrependAnchor } from '@/components/chat/use-prepend-anchor';
import { useCachedTimeline, useTimelineWriteThrough } from '@/lib/chat-cache/use-chat-cache';
import { ConfirmIconButton } from '@/components/chat/confirm-icon-button';
import { EmptyChat } from '@/components/chat/empty-chat';
import { TypingIndicator } from '@/components/chat/message-bits';
import { MessageTimeline } from '@/components/chat/message-timeline';
import { ComposeBar, QueueBar, type ComposerHandle } from '@/components/chat/composer';
import { VoiceMic } from '@/components/chat/voice-mic';
import { DictationDock, type DictationHandle, type DictationSource } from '@/components/chat/dictation-dock';
import { FabDock } from '@/components/chat/fab-dock';
import { PreviewFab } from '@/components/chat/preview-fab';
import { LivePreviewPanel, parseLivePreview } from '@/components/chat/preview-panel';
import { SessionDetailSheet } from '@/components/chat/session-detail-sheet';
import { runtimeShortLabel, runtimeDetail, hasTmuxPane } from '@/lib/runtime-labels';

// isTouchPrimary (phone/tablet vs desktop) lives in @/lib/save-file — the
// soft-keyboard return key inserts a newline there (a dedicated send button
// handles sending), and the same gate drives the share-vs-download save path.

// The LIVE window: the newest N messages, and the only thing listMessages (and
// the SSE stream keyed on it) ever carries. Kept small so a session opens fast —
// less JSON over the wire + far fewer markdown/highlight passes on first paint —
// since the visible viewport is only ~15-20 messages. MUST match the sidebar's
// `listMessages` prefetch limit (app-sidebar.tsx) so a session click stays a
// cache hit.
//
// It is FIXED. "Load earlier" used to grow it, which made each click re-fetch
// everything already on screen and dragged the SSE stream up with it; older
// history is now paged separately by useOlderPages.
const INITIAL_WINDOW = 60;

// How long the message pane keeps re-asserting the bottom after its size
// changes. Covers a multi-step composer growth (each new line is its own resize,
// and the browser's own scroll adjustment lands a frame later).
const SETTLE_AFTER_RESIZE_MS = 400;

// Frames of "hold the end" granted to an explicit jump-to-latest while the
// conversation is still growing — long enough to outlast the smooth scroll it
// starts. Only ever spent on a user gesture, unlike the per-change budget in
// the sticky-bottom effect.
const SETTLE_CHASE_FRAMES = 24;

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

// The "New chat" screen, split out behind React.lazy. It is a BRANCH you have to
// click into (?new=1 / ?agent=…) — the normal /chat landing renders SessionPane —
// yet it was the only static path from this module to @/components/ui/select, and
// base-ui's Select drags its popup + floating-position engine along as a 136 KB
// chunk. That chunk sat on the blocking script list of /chat, /brain and
// /brain/dispatch (the three heaviest routes; /brain re-exports SessionPane from
// here) for a form most page loads never show. Warmed on idle in ChatPageInner
// below, so clicking New chat still finds it in cache.
const NewChatPane = lazy(() => import('@/components/chat/new-chat-pane').then((m) => ({ default: m.NewChatPane })));

// Shown only while that chunk is in flight. Mirrors the pane's own frame (header
// + centered max-w-md card) so the swap doesn't move anything; the mobile sidebar
// toggle stays live so the screen is never a dead end.
function NewChatFallback() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">New chat</span>
      </header>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm" aria-hidden="true">
          <div className="flex flex-col items-center gap-2">
            <Skeleton className="h-12 w-12 rounded-2xl" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-[38px] w-full rounded-lg" />
          <Skeleton className="h-[58px] w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
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
  // It's also only READ by the landing redirect (pick a session when none is in
  // the URL) and the new-chat pane — the open-session view never touches
  // agents.data — so don't subscribe while viewing a session. On desktop the
  // sidebar's RecentAgents still polls the shared key; but on mobile / a
  // collapsed sidebar (that list unmounted) the chat page was the SOLE
  // subscriber, needlessly polling a machine-wide groupBy every 30s. (P1-3)
  const agents = trpc.agents.list.useQuery(undefined, {
    refetchInterval: 30_000,
    enabled: !scope.scoped && (!sessionParam || showNew),
  });
  // No own refetchInterval — the always-mounted sidebar already polls
  // listSessions every 5s; this shares that cache (used here only for the
  // landing redirect + empty state). Drops a duplicate 5s poll/re-render.
  const sessions = trpc.chat.listSessions.useQuery({});

  // Warm the New-chat chunk on idle — same trick markdown.tsx uses. It is off the
  // critical path (fires after first paint, at idle priority) but lands well before
  // the New chat button gets clicked, so the split above costs no perceived latency.
  // Lives HERE rather than at module scope on purpose: /brain imports SessionPane
  // from this file and never shows the pane, so it should not pay for the fetch.
  useEffect(() => {
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void };
    const warm = () => { void import('@/components/chat/new-chat-pane'); };
    (w.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500)))(warm);
  }, []);

  // Selection is URL-driven (?session=<id>); the global app sidebar owns the
  // session list + New chat. When nothing is selected and we're not composing a
  // new chat, land on the chat this browser last had open — falling back to the
  // most recent one — so the area is never blank AND reopening the app (closed
  // tab, relaunched PWA, machine switch) resumes the conversation you were in.
  useEffect(() => {
    // A session id in the URL that this machine doesn't have is treated as no id at
    // all, so the landing below runs instead of leaving the pane stranded on a chat
    // that cannot load. Three ways to get one, and the switcher just made the first
    // routine: arriving from a machine switch with a remembered id that has since
    // been deleted there, a bookmark/PWA restore pointing at another machine's
    // session, and an open chat that was trashed (getSession excludes the bin).
    //
    // Guarded on a SETTLED list — while listSessions is still loading, every id
    // looks unknown, and redirecting then would fight the URL on every load.
    const known = sessions.data;
    const stale = !!sessionParam && !!known && !known.some((s) => s.id === sessionParam);
    if (sessionParam && !stale) return;
    const rows = known ?? [];
    // Prefer the remembered session, but only while it's still one we'd be willing
    // to land on: it may have been deleted, hidden, or moved out of scope since.
    const resume = (ok: (s: (typeof rows)[number]) => boolean) => {
      const id = lastSessionId();
      return (id ? rows.find((s) => s.id === id && ok(s)) : undefined) ?? rows.find(ok);
    };
    // Scoped share session: the link drops you at /chat?agent=X. Default into the
    // most recent EXISTING chat with the agent; only show the new-chat compose
    // when there are none, or when New chat was explicitly clicked (?new=1).
    if (scope.scoped) {
      if (search.get('new')) return;
      const recent = resume((s) => !s.hiddenAt && s.origin !== 'dispatch');
      if (recent) window.location.href = `/chat?session=${encodeURIComponent(recent.id)}`;
      return;
    }
    if (showNew) return;
    // Skip the orchestrator (Brain) — its chats live only in /brain, never the
    // dashboard. (listSessions still returns them; we just never land on one.)
    const brainName = agents.data?.find((a) => a.isOrchestrator)?.name;
    // Also skip hidden sessions (the user decluttered them) and Brain's dispatch
    // sessions (origin:'dispatch' — those live only in /brain/dispatch).
    const first = resume((s) => s.agentName !== brainName && !s.hiddenAt && s.origin !== 'dispatch');
    // `replace`, not push: a URL we are correcting should not become a back-button
    // stop. When it was stale, go browser-native — a router.replace from
    // /chat?session=A to /chat?session=B is same-path-different-param, the case
    // this setup is documented to swallow (see the onCreated note below).
    if (first) {
      if (stale) window.location.href = `/chat?session=${encodeURIComponent(first.id)}`;
      else router.replace(`/chat?session=${encodeURIComponent(first.id)}`);
    }
  }, [showNew, sessionParam, sessions.data, agents.data, router, scope.scoped, search]);

  // Remember the open chat (per machine) so the landing effect above can resume it
  // the next time this browser arrives at a bare /chat. See lib/last-session.ts.
  useEffect(() => {
    if (sessionParam) rememberSession(sessionParam);
  }, [sessionParam]);

  if (showNew) {
    return (
      <Suspense fallback={<NewChatFallback />}>
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
      </Suspense>
    );
  }

  if (sessionParam) {
    // key remounts SessionPane on session switch — resets scroll + streaming
    // refs cleanly (no carry-over between sessions).
    // `msg` (set by a global-search hit) opens the session positioned on that
    // message instead of at the live tail.
    return <SessionPane key={sessionParam} sessionId={sessionParam} anchorMessageId={search.get('msg')} />;
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
// Summary mode: the conversation, without the machinery.
//
// Two failed shapes got us here. First it kept only the CLOSING reply of each
// turn — a 60-row conversation became 5 rows and answers arrived from nowhere.
// Then it kept the prose plus `tool_use` chips, which restored the thread but
// put the machinery back on screen; the chips are what you turn summary mode ON
// to escape.
//
// So: everything a person said or was told, and nothing about how it was
// carried out.
//
//   keep   user messages, system messages
//   keep   every assistant `text` block — including the mid-turn narration,
//          which is where the agent explains what it found and why it's about
//          to do something. That IS the useful signal.
//   drop   `tool_use`, `tool_result`, `thinking`, the harness terminator, and
//          images (attachments belong to the full view)
//
// A message left with nothing after filtering disappears entirely, so a turn
// that was purely mechanical collapses to nothing rather than to an empty bubble.
const SUMMARY_KEEP = new Set(['text']);
// Filtered content arrays are cached against the ORIGINAL array, so toggling
// summary mode or re-rendering on a stream tick hands memo(MessageRow) the same
// object identity it saw last time instead of forcing a full re-render.
const summaryContentCache = new WeakMap<object, unknown[] | null>();

function summarizeContent(content: unknown): unknown[] | null {
  if (!Array.isArray(content)) return null;
  const cached = summaryContentCache.get(content);
  if (cached !== undefined) return cached;
  const kept = content.filter(
    (b: any) => b && typeof b === 'object' && SUMMARY_KEEP.has(b.type) && typeof b.text === 'string' && b.text.trim().length > 0
  );
  // Return the ORIGINAL array when nothing was dropped, so memo(MessageRow)
  // sees an unchanged `content` prop for the many messages that are pure prose.
  const result = kept.length === 0 ? null : kept.length === content.length ? content : kept;
  summaryContentCache.set(content, result);
  return result;
}

function toSummaryView(messages: TimelineMsg[]): TimelineMsg[] {
  const isToolResultOnly = (c: any) =>
    Array.isArray(c) && c.length > 0 && c.every((b: any) => b?.type === 'tool_result');
  const hasText = (c: any) =>
    Array.isArray(c) && c.some((b: any) => b?.type === 'text' && (b.text ?? '').trim());
  const out: TimelineMsg[] = [];
  for (const m of messages) {
    // A human turn and system notices always survive verbatim.
    if (m.role === 'system' || (m.role === 'user' && hasText(m.content) && !isToolResultOnly(m.content))) {
      out.push(m);
      continue;
    }
    // Tool results and the harness terminator are exactly what's being summarized away.
    if (isToolResultOnly(m.content) || isHarnessTerminator(m.content)) continue;
    const kept = summarizeContent(m.content);
    if (!kept) continue;
    out.push(kept === m.content ? m : { ...m, content: kept });
  }
  return out;
}

// Composer draft state + per-session localStorage persistence now live IN
// ComposeBar (components/chat/composer.tsx) so a keystroke re-renders only the
// composer, not this whole pane. SessionPane's occasional draft writes go
// through the imperative ComposerHandle (composerRef) below.

export function SessionPane({ sessionId, anchorMessageId = null }: { sessionId: string; anchorMessageId?: string | null }) {
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
  // the gap-filler for the header AND — since P1-2 dropped the whole-.loop-state
  // blob from listSessions to slim that 5s payload (it was 38% of it) — the
  // source of the current session's `loopState` for the LoopBar. So it now polls
  // at 5s to keep the loop card as fresh as the old listSessions-driven path; a
  // single-row PK query, so the extra poll is cheap and only runs on /chat.
  const sessionOne = trpc.chat.getSession.useQuery({ sessionId }, { enabled: !!sessionId, staleTime: 30_000, refetchInterval: 5_000 });
  const session = sessionMeta.data?.find((s) => s.id === sessionId) ?? sessionOne.data ?? undefined;
  // Live updates arrive via SSE (/api/chat/stream), written straight into this
  // query's cache. The poll below is only a fallback for when the stream isn't
  // connected (the gateway flushes block-level rows into Postgres either way).
  const [streamConnected, setStreamConnected] = useState(false);
  // Fixed live window — see INITIAL_WINDOW. Older history lives in `older`.
  const limit = INITIAL_WINDOW;
  const [summaryMode, toggleSummary] = useSummaryMode();
  const [findOpen, setFindOpen] = useState(false);
  // Live preview (hermit-preview CLI → gateway preview module → livePreview
  // column). Sourced from the single-row getSession poll — the merged `session`
  // row may come from listSessions, which deliberately never carries it.
  const livePreview = parseLivePreview(sessionOne.data?.livePreview);
  // The URL the user opened the panel FOR. Open-ness is derived from identity
  // rather than a boolean an effect has to reset: a withdrawn or replaced
  // registration stops matching and the panel closes by construction.
  const [previewOpenUrl, setPreviewOpenUrl] = useState<string | null>(null);
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
  // Recycle bin, not a hard delete — see the sidebar's note and
  // docs/session-cleanup-design.md. Recoverable, and the pane is hibernated
  // rather than stranded.
  const deleteSession = trpc.chat.trashSessions.useMutation({
    onSuccess: () => { window.location.href = '/chat'; },
  });
  const restartSession = trpc.chat.requestSessionRestart.useMutation({
    onSuccess: () => sessionMeta.refetch(),
  });
  // Take an archived chat back out of the archive, from inside the chat itself.
  // Until this existed the only way back was the sidebar's right-click menu under
  // `Show hidden & archived` — but an archived chat is perfectly reachable from
  // search (or a bookmarked ?session= url), and landing in one meant a dead end: a
  // greyed composer reading "session is closed" and no visible way out.
  //
  // Clears closedAt only, exactly like the sidebar's `Restore from archive`. The
  // session stays hibernated and wakes on the next message (--resume).
  //
  // Writes both caches before refetching: the header and the composer read
  // `closedAt` off the listSessions ROW in preference to getSession (see `session`
  // above), and that list is the ~0.5–0.9s query — so a refetch-only path would
  // leave the composer disabled for most of a second after the click.
  const reopenSession = trpc.chat.reopenSession.useMutation({
    onSuccess: () => {
      utils.chat.listSessions.setData({}, (old) =>
        old?.map((s) => (s.id === sessionId ? { ...s, closedAt: null } : s)),
      );
      utils.chat.getSession.setData({ sessionId }, (old) => (old ? { ...old, closedAt: null } : old));
      void sessionMeta.refetch();
      void sessionOne.refetch();
    },
  });
  // "Another chat with this same agent" — the header shortcut for the flow that
  // otherwise costs a trip through /chat?new=1 and re-picking the agent. Hard
  // navigation for the same Next 16 reason as onCreated/delete above: a
  // router.push to the SAME path with a different ?session= is silently
  // swallowed, which would leave you looking at the old session.
  const newAgentChat = trpc.chat.createSession.useMutation({
    onSuccess: (s) => { window.location.href = `/chat?session=${encodeURIComponent(s.id)}`; },
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

  // The draft VALUE lives inside ComposeBar now; we reach it only for the rare
  // out-of-band writes (empty-state chip, voice transcript, send clear/restore)
  // via this imperative handle — so typing never re-renders SessionPane.
  const composerRef = useRef<ComposerHandle>(null);
  // Realtime dictation lives in its own dock (above the composer) so the text
  // arriving ~36×/second re-renders the composer's own draft and nothing else.
  // All that reaches here is a ref to drive it and two booleans the mic draws.
  const dictationRef = useRef<DictationHandle>(null);
  const [dictating, setDictating] = useState(false);
  const [slideCancelArmed, setSlideCancelArmed] = useState(false);
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
  // Mobile header overflow: the phone header only has room for the two actions
  // you actually reach for mid-conversation (tmux, delete), so the rest live in a
  // tray that slides out leftward OVER the title. Desktop keeps everything inline.
  const [moreOpen, setMoreOpen] = useState(false);
  // Session detail (incl. the backend switcher). Local state, not a URL param:
  // this app's programmatic same-path navigations get swallowed (see the
  // window.location comments around NewChatPane), and a sheet over the
  // conversation has nothing to gain from being linkable.
  const [detailOpen, setDetailOpen] = useState(false);
  const detailEverOpened = useRef(false);
  if (detailOpen) detailEverOpened.current = true;
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    // Close on a tap anywhere else / Esc. NOT on clicks inside the tray: the
    // destructive actions in there are two-step (ConfirmIconButton arms first),
    // and closing on the arming tap would make them impossible to confirm.
    const onDown = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);
  const [titleDraft, setTitleDraft] = useState('');
  const setTitleMut = trpc.chat.setTitle.useMutation({
    onSuccess: () => { sessionMeta.refetch(); setEditingTitle(false); },
  });

  // Auto-title. The server is idempotent (it no-ops when a title exists), so
  // this fires once per session per mount and needs no client-side bookkeeping
  // beyond "don't ask twice for the same id". Only asks once the conversation
  // has something to summarize — a session with one message has no subject yet.
  const autoTitleMut = trpc.chat.autoTitle.useMutation({
    onSuccess: (r) => { if (r.title) { sessionMeta.refetch(); sessionOne.refetch(); } },
  });
  const autoTitleAsked = useRef<string | null>(null);
  useEffect(() => {
    // Fires on every open, titled or not: the server answers from two indexed
    // queries unless the conversation has actually moved on, so this costs
    // nothing in the common case and lets a long-running session's title keep
    // up with what it turned into.
    if (!sessionId) return;
    if ((messages.data?.length ?? 0) < 2) return;
    if (autoTitleAsked.current === sessionId) return;
    autoTitleAsked.current = sessionId;
    autoTitleMut.mutate({ sessionId, force: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, messages.data?.length]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Floating voice-mic visibility (Settings → hermit:hide-voice-mic). Read on
  // mount + on cross-tab storage events so toggling it takes effect without a reload.
  const [micHidden, setMicHidden] = useState(false);
  useEffect(() => {
    const read = () => { try { setMicHidden(localStorage.getItem('hermit:hide-voice-mic') === '1'); } catch { /* ignore */ } };
    read();
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, []);

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
  // Viewport height as of the last scroll event — how the scroll listener tells
  // "the pane resized under me" from "the user scrolled".
  const lastClientHeightRef = useRef(0);
  // Scroll position as of the last scroll event, so we can tell which DIRECTION
  // the user moved. Only an upward move means "I want to read history".
  const lastScrollTopRef = useRef(0);
  // While the pane is settling after a size change, the bottom is re-asserted
  // every frame and NOTHING is read as user intent. Needed because a composer
  // growth does not land in one step: the stick takes, and then the browser
  // pulls scrollTop back by the exact height the composer gained — which is
  // indistinguishable, event-by-event, from the user scrolling up.
  const settleUntilRef = useRef(0);
  // Treat the very first paint as a "scroll to bottom" regardless of position.
  const firstScrollRef = useRef(true);
  // Installed by the sticky-bottom effect below: "re-assert the bottom for the
  // next N frames". scrollToBottom uses it to chase a bottom that is still
  // moving; the effect owns it because the loop and its budget live there.
  const settleKickRef = useRef<((frames: number) => void) | null>(null);

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
    // A smooth scroll animates toward the offset captured RIGHT NOW. Fine on a
    // settled conversation — but while a reply streams in, the bubble keeps
    // growing under the animation and it lands short of the end, by more than
    // the scroll listener's 60px slack, so nothing re-pins and the pill the user
    // just clicked stays on screen. Chase the end for the length of the
    // animation, but only when the content is known to be moving (the
    // sticky-bottom observer refreshed this window within the last
    // SETTLE_AFTER_RESIZE_MS) — an idle conversation keeps its smooth glide.
    if (Date.now() <= settleUntilRef.current) {
      settleUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
      settleKickRef.current?.(SETTLE_CHASE_FRAMES);
    }
    requestAnimationFrame(() => { autoScrollRef.current = false; });
  }, [getViewport, setPinned]);

  // ── Local cache: first paint from disk, and the write-through that fills it ──
  // `cachedRows` is null until the IndexedDB lookup resolves, [] when there's
  // nothing stored. Only used while the server query is still pending — once
  // real data lands it always wins, so a stale cache can never mask live state.
  const cachedRows = useCachedTimeline(sessionId);
  useTimelineWriteThrough(sessionId, messages.data);
  const windowRows = useMemo(
    () => messages.data ?? (cachedRows && cachedRows.length > 0 ? cachedRows : undefined),
    [messages.data, cachedRows]
  );

  // Older history, paged separately from the live window and served from the
  // local cache whenever it has the page. See use-older-pages.ts.
  const older = useOlderPages(
    sessionId,
    windowRows?.[0],
    (messages.data?.length ?? 0) >= limit,
    summaryMode
  );
  const baseRows = useMemo(
    () => (older.rows.length > 0 ? [...older.rows, ...(windowRows ?? [])] : windowRows),
    [older.rows, windowRows]
  );

  // "load earlier" prepends from the top. The reading position is pinned to the
  // message the user was looking at and HELD there while the new history lays
  // out — see use-prepend-anchor.ts for why a one-shot height restore isn't
  // enough.
  const prependAnchor = usePrependAnchor(getViewport);
  // Read by the scroll listener and the bottom-pin observer, neither of which
  // should re-subscribe when the anchor object identity changes.
  const prependAnchorRef = useRef(prependAnchor);
  prependAnchorRef.current = prependAnchor;
  // Depend on the two CALLBACKS, not on the objects carrying them. Both
  // `usePrependAnchor` and `useOlderPages` hand back a fresh object literal
  // every render, so `[prependAnchor, older]` made this — and `pullEarlier`
  // below, and the scroll listener that depends on it — a new identity on
  // every tick. The listener effect then tore itself down and re-subscribed on
  // every render, and its setup reads `clientHeight`/`scrollTop`, which forces
  // a synchronous layout each time: 11 subscriptions and 9 forced reflows just
  // to open a conversation, then 3 listeners swapped per render forever after.
  // `capture` and `loadMore` are stable across ordinary renders (loadMore only
  // changes when the top row does, i.e. after a prepend), so the listener now
  // subscribes once and the refs above are what keep it current.
  const capturePosition = prependAnchor.capture;
  const loadMoreOlder = older.loadMore;
  const loadEarlier = useCallback(() => {
    capturePosition();
    loadMoreOlder();
  }, [capturePosition, loadMoreOlder]);

  // Put the reading position back BEFORE the browser paints the taller list.
  // A layout effect is the only place that can: by the time a rAF callback runs
  // the displaced frame is already on screen, and a 200-message prepend can
  // block the main thread long enough that "already on screen" lasts seconds.
  useIsoLayoutEffect(() => {
    prependAnchor.reassert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [older.rows.length]);

  // Eligibility for an infinite-scroll-up pull. Held in a ref so the scroll
  // listener reads the latest value without re-subscribing every render.
  const canLoadEarlierRef = useRef(false);
  canLoadEarlierRef.current = older.hasMore && !older.loading;
  // Pull the next page of history. Cleared immediately so one fling fires one
  // pull; recomputed from `older.loading` on the next render.
  const pullEarlier = useCallback(() => {
    if (!canLoadEarlierRef.current) return;
    canLoadEarlierRef.current = false;
    loadEarlier();
  }, [loadEarlier]);

  // Anchored mode: viewing a window around one specific message (a search hit).
  // Frozen — see use-anchored-window.ts.
  const anchored = useAnchoredWindow(sessionId, anchorMessageId, getViewport);
  // Read by the sticky-bottom effect, which must not re-subscribe per render.
  const anchoredActiveRef = useRef(false);
  anchoredActiveRef.current = anchored.active;

  // The rendered timeline. Summary mode collapses each turn to its final reply;
  // useMemo keeps the array reference stable between refetches so memo(MessageTimeline) still bails on no-op ticks.
  const view = useMemo(() => {
    if (anchored.active) return anchored.rows ?? [];
    const base = summaryMode ? toSummaryView(baseRows ?? []) : (baseRows ?? []);
    if (pending.length === 0) return base;
    // Drop any optimistic row whose real counterpart (same user text) has landed.
    const sent = new Set((messages.data ?? []).filter((m) => m.role === 'user').map((m) => msgText(m.content)));
    const live = pending.filter((p) => !sent.has(msgText(p.content)));
    return live.length ? [...base, ...live] : base;
  }, [messages.data, baseRows, summaryMode, pending, anchored.active, anchored.rows]);

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
    // Anchored mode positions the viewport on a specific message; jumping to the
    // bottom on first paint would undo exactly what the user clicked for.
    if (firstScrollRef.current && !anchoredActiveRef.current) { firstScrollRef.current = false; toBottom(); }
    // Re-assert the bottom for a few frames after each height change, so a single
    // assignment losing a race to the browser's own adjustment doesn't leave the
    // conversation parked short of the end.
    //
    // It is a short burst per change, NOT a poll of the whole settling window,
    // so the work is 1 + SETTLE_FRAMES asserts per height change on any display
    // instead of one per frame for as long as the height keeps changing. It used
    // to run every frame until settleUntilRef expired — and since every resize
    // pushed that 400ms out again, a streaming turn (this observer fires ~4×/s
    // while a reply grows) kept it spinning at frame rate from the first token to
    // the last: measured over a 10s stream, ~210 `scrollHeight` reads and ~370 rAF
    // callbacks against 40 actual content changes, and `get scrollHeight` was the
    // hottest app frame in the whole streaming state. Anything that moves the
    // content later fires the observer again and gets its own burst, and a
    // browser-side scroll adjustment is caught by the scroll listener (which
    // still re-pins for the full settleUntilRef window — untouched below).
    const SETTLE_FRAMES = 2;
    let framesLeft = 0;     // re-asserts still owed to the last height change
    let raf = 0;            // live settle chain, 0 when idle
    const settle = () => {
      raf = 0;
      if (framesLeft <= 0 || Date.now() > settleUntilRef.current) return;
      framesLeft -= 1;
      if (pinnedRef.current && !prependAnchorRef.current?.isHolding() && !anchoredActiveRef.current) toBottom();
      raf = requestAnimationFrame(settle);
    };
    const kick = (frames: number) => {
      framesLeft = Math.max(framesLeft, frames);
      if (!raf) raf = requestAnimationFrame(settle);
    };
    settleKickRef.current = kick;
    const ro = new ResizeObserver(() => {
      if (prependAnchorRef.current?.isHolding()) return; // holding a read position after a prepend
      if (anchoredActiveRef.current) return;   // reading history at a fixed anchor
      settleUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
      if (pinnedRef.current) toBottom();
      kick(SETTLE_FRAMES);
    });
    ro.observe(content);
    // ALSO watch the viewport itself. The composer grows as you type a multi-line
    // message, which shrinks this pane from the bottom — the content is
    // untouched, so a content-only observer never fires and the last messages
    // slide behind the composer while the view sits there looking stuck.
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      settleKickRef.current = null;
    };
  }, [getViewport]);


  // Track the user's scroll intent. Ignore scrolls WE triggered (autoScrollRef)
  // so an auto-follow never unpins them; a real upward scroll past the slack
  // unpins (and reveals the "scroll to bottom" pill). ~60px slack tolerates
  // small async layout shifts without unpinning.
  useEffect(() => {
    const el = getViewport();
    if (!el) return;
    lastClientHeightRef.current = el.clientHeight;
    lastScrollTopRef.current = el.scrollTop;
    const onScroll = () => {
      // Update the baselines FIRST, even for scrolls we caused — otherwise the
      // next comparison is made against a stale position.
      const st = el.scrollTop;
      const wentUp = st < lastScrollTopRef.current - 2;
      lastScrollTopRef.current = st;
      const h = el.clientHeight;
      const resized = h !== lastClientHeightRef.current;
      lastClientHeightRef.current = h;
      if (autoScrollRef.current) return;

      // The pane changed size under us — growing the composer shrinks this
      // viewport from the bottom. That's layout, not a decision to read history.
      if (resized) settleUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
      // Inside the settling window nothing is a verdict on intent; the rAF loop
      // started by the ResizeObserver is holding the bottom.
      if (Date.now() < settleUntilRef.current) {
        if (pinnedRef.current) {
          autoScrollRef.current = true;
          el.scrollTop = el.scrollHeight;
          requestAnimationFrame(() => { autoScrollRef.current = false; });
        }
        return;
      }

      // Pin state follows INTENT, not geometry. Unpin only when the user
      // actually moved upward; re-pin whenever they're back at the end.
      //
      // Deriving it from the gap alone (`setPinned(gap < 60)`) looked
      // equivalent and wasn't: scroll events are dispatched asynchronously and
      // routinely outlive the one-frame guard on our own auto-scrolls, so a
      // late event would arrive after the composer had grown, see a large gap
      // nobody asked for, and quietly unpin — stranding the conversation short
      // of the end with a "↓ latest" pill.
      const gap = el.scrollHeight - st - h;
      if (gap < 60) setPinned(true);
      else if (wentUp) setPinned(false);

      // Infinite scroll up: near the top, pull the next page of history.
      // loadEarlier anchors the scroll so the prepend doesn't yank the viewport.
      if (st < 200) pullEarlier();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // A scroll event is not enough on its own. Once the viewport is clamped at
    // the top the browser stops firing them, so someone who flings past the top
    // and keeps pushing sits there with nothing happening — the pull that would
    // have fetched the next page never gets a chance to run. The raw gesture
    // still arrives, so use it as the second entry point.
    const onReach = (e: Event) => {
      if (el.scrollTop >= 200) return;
      if (e.type === 'wheel' && (e as WheelEvent).deltaY >= 0) return; // scrolling away, not into, the top
      pullEarlier();
    };
    el.addEventListener('wheel', onReach, { passive: true });
    el.addEventListener('touchmove', onReach, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onReach);
      el.removeEventListener('touchmove', onReach);
    };
  }, [getViewport, setPinned, pullEarlier]);

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

  // Which backend runs this session, resolved server-side (a session's own
  // runtime may be null = inherit the agent's). Shown next to ctx because both
  // describe the run rather than the conversation. Both backends are labelled,
  // not just the non-default one: in a mixed fleet "no badge" would be ambiguous
  // between "Claude Code" and "the header hasn't loaded".
  const backendLabel = runtimeShortLabel(session?.runtime);
  const backendTitle = `${runtimeDetail(session?.runtime, session?.runtimeProvider, session?.runtimeModel)} — click for session details`;

  // The in-dialog "thinking" dots are driven by the SAME status as the header
  // dot, so the two can never disagree. The old code keyed the dots off local
  // SSE signals (isWaitingAssistant / streamingTailId), which settle out of step
  // with the gateway's pane-derived `working` — e.g. a long tool call with no new
  // block for >1.8s cleared the dots while the header still read "working". Show
  // them whenever the session is working OR coming up (starting / restarting).
  const showThinkingDots =
    status.key === 'working' || status.key === 'starting' || status.key === 'restarting';

  // Stop is a control of its own, above the composer — never a circle inside it.
  const showStopPill = isInFlight && !session?.closedAt;

  // Viewing a session = reading it. Stamp it read on open and on every new
  // message that lands while open, so it never shows the red "unread" dot to the
  // sidebar / agent-detail views (on any device) once we've seen the latest.
  const markRead = useMarkSessionRead();
  useEffect(() => {
    markRead(sessionId);
  }, [markRead, sessionId, messages.data?.length, isInFlight]);

  // Esc cancels the running turn — but only when that Esc isn't already doing
  // something else. This used to be a bare `window` listener that took every
  // Escape on the page, so killing the agent was a side effect of: dismissing an
  // IME composition while typing (the same keystroke for anyone writing Chinese),
  // closing the image lightbox, closing in-chat find, closing the mobile sidebar.
  // Three guards, cheapest first: someone already handled it; you're in a text
  // field (the composer also stops propagation itself); or a layer that owns Esc
  // is open — those mark themselves with data-esc-layer.
  useEffect(() => {
    if (!isInFlight || session?.closedAt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (document.querySelector('[data-esc-layer]')) return;
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
      ta.focus({ preventScroll: true });
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

  // Empty-state chip / loop templates → fill compose, focus caret at end, resize.
  // (The value + textarea manipulation live in ComposeBar; this just drives it.)
  const pickPrompt = useCallback((text: string) => {
    composerRef.current?.setText(text);
  }, []);

  // Voice transcript → APPEND to the current draft (never clobber typed text),
  // then focus + caret-to-end + resize (all handled inside ComposeBar).
  // Stable so the memo'd VoiceMic doesn't get fresh props on every SSE tick.
  const startDictation = useCallback((source: DictationSource) => dictationRef.current?.start(source), []);
  const stopDictation = useCallback(() => dictationRef.current?.stop(), []);
  const cancelDictation = useCallback(() => dictationRef.current?.cancel(), []);
  const onDictationActive = useCallback((live: boolean) => {
    setDictating(live);
    if (!live) setSlideCancelArmed(false);
  }, []);

  // Stable callbacks for the memo'd LoopBar — inline arrows here would give it a
  // fresh prop identity on every SSE tick and defeat the memo. pickPrompt is
  // stable; the *_TEMPLATE strings are module constants.
  const startLoop = useCallback(() => pickPrompt(LOOP_TEMPLATE), [pickPrompt]);
  const startCron = useCallback(() => pickPrompt(CRON_TEMPLATE), [pickPrompt]);
  const startAutonomy = useCallback(() => pickPrompt(AUTONOMY_TEMPLATE), [pickPrompt]);

  // The header's secondary actions, rendered TWICE (inline on ≥sm, in the mobile
  // tray on phones) — one definition so the two can't drift. Only one is visible
  // at a time, so the duplicated ConfirmIconButton arm-state is harmless.
  // ── Brain takeover ────────────────────────────────────────────────────────
  // Not gated on agents.list: that query is deliberately disabled while a session
  // is open (P1-3), and re-enabling it just to learn the Brain's name would undo
  // that. The two cases worth hiding for are cheap to read off the session itself —
  // a scoped share key (requestTakeover is machineProcedure and would 403) and a
  // dispatch session (already the Brain's own work). The Brain-can't-drive-itself
  // case is enforced server-side, and its chats don't appear on this page anyway.
  // Read off sessionOne (getSession), not `session` — which prefers the
  // listSessions row. Same call the LoopBar makes for `loopState`: that 5s poll is
  // machine-wide and was deliberately slimmed (P1-2), so per-session state belongs
  // on the single-row query, which polls at the same 5s anyway.
  const takeover = sessionOne.data;
  const takenOver = !!takeover?.takeoverBySessionId;
  const canTakeover =
    !scope.scoped && !!session && !session.closedAt && session.origin !== 'dispatch' && !takenOver;
  const requestTakeover = trpc.chat.requestTakeover.useMutation({
    onSuccess: () => { utils.chat.getSession.invalidate({ sessionId }); utils.chat.listMessages.invalidate({ sessionId }); },
  });
  const releaseTakeover = trpc.chat.releaseTakeover.useMutation({
    onSuccess: () => { utils.chat.getSession.invalidate({ sessionId }); utils.chat.listMessages.invalidate({ sessionId }); },
  });

  // What's in the floating dock. The takeover button stays visible while a takeover
  // is LIVE even though canTakeover has gone false — it's the way to take the
  // conversation back, so it must not vanish the instant it starts working.
  // The takeover chip stays visible while a takeover is LIVE even though canTakeover
  // has gone false — it's the way to take the conversation back.
  const showTakeover = canTakeover || takenOver;
  const showMicFab = !micHidden && !session?.closedAt;
  const hasLivePreview = !!livePreview && !session?.closedAt;
  const previewOpen = hasLivePreview && !!previewOpenUrl && previewOpenUrl === livePreview?.url;
  // Cmd/Ctrl+\ toggles the live-preview split — VS Code's split-editor key,
  // free in every browser. Same shape as the ⌘/ and ⌘F handlers above; a
  // no-op unless the session has a registered preview (the FAB's condition).
  const livePreviewUrl = hasLivePreview ? (livePreview?.url ?? null) : null;
  useEffect(() => {
    if (!livePreviewUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '\\' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setPreviewOpenUrl((cur) => (cur === livePreviewUrl ? null : livePreviewUrl));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [livePreviewUrl]);

  const secondaryActions = (
    <>
      <button
        type="button"
        onClick={() => { setDetailOpen(true); setMoreOpen(false); }}
        aria-label="session details"
        title="Session details — backend, process, history"
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
      >
        <Info className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => setFindOpen((v) => !v)}
        aria-pressed={findOpen}
        aria-label="find in conversation"
        title="Find in this conversation (⌘F)"
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
        title={summaryMode ? 'Showing replies only — click for the full run' : 'Show only what was said, hiding tool calls and intermediate steps'}
        className={cn(
          'inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors cursor-pointer',
          summaryMode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <ListCollapse className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => {
          if (!session?.agentName || newAgentChat.isPending) return;
          newAgentChat.mutate({ agentName: session.agentName });
        }}
        disabled={!session?.agentName || newAgentChat.isPending}
        aria-label="new chat with this agent"
        title={session?.agentName ? `New chat with ${session.agentName}` : 'New chat with this agent'}
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-50"
      >
        <SquarePen className="h-4 w-4" />
      </button>
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
    </>
  );

  return (
    <>
      {/* The split row: chat column (its header INCLUDED, so the preview
          panel's h-12 header sits on the same line and the divider runs the
          full height) + the live-preview panel as the right sibling on lg+.
          On phones the panel is a fixed full-screen layer, so this row is
          free there. */}
      <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {/* @container: with the split open the chat column is far narrower than
          the viewport, so the action cluster folds by the COLUMN's real width
          (container query), not the sm viewport breakpoint. */}
      <div className="@container border-b border-border px-4 h-12 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarMobileToggle />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground leading-tight min-w-0">
              {editingTitle ? (
                <>
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
                {/* Regenerate from the conversation. `force` — this one overwrites
                    whatever is there, since the user asked for it explicitly.
                    onMouseDown, not onClick: the input's onBlur fires first and
                    would commit the draft (and close the editor) before a click
                    ever landed. */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    autoTitleMut.mutate(
                      { sessionId, force: true },
                      { onSuccess: (r) => { if (r.title) setTitleDraft(r.title); } }
                    );
                  }}
                  disabled={autoTitleMut.isPending}
                  title="Regenerate the title from the conversation"
                  aria-label="regenerate title from the conversation"
                  className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-wait"
                >
                  <Sparkles className={cn('h-3.5 w-3.5', autoTitleMut.isPending && 'animate-pulse')} />
                </button>
                </>
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
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground truncate">
              {/* Agent name leads the status line on every width — on a phone the
                  sidebar is collapsed away, so this was the only thing telling you
                  WHICH agent you're talking to. It's the ONLY shrinkable item on the
                  row (capped + truncating), so a long name yields instead of pushing
                  the state or ctx off the edge. */}
              {session?.agentName ? (
                // …and it's the way INTO the agent: /agents?name=<agent> is the
                // detail sheet's deep link (same one the sidebar's Agents entry uses).
                <Link
                  href={`/agents?name=${encodeURIComponent(session.agentName)}`}
                  title={`Open ${session.agentName} details`}
                  className="min-w-0 max-w-[9rem] truncate text-foreground/70 transition-colors hover:text-foreground hover:underline underline-offset-2"
                >
                  {session.agentName}
                </Link>
              ) : (
                <span className="min-w-0 max-w-[9rem] truncate text-foreground/70">{session?.agentName}</span>
              )}
              {session && (
                <>
                  <span className="shrink-0 text-muted-foreground/40">·</span>
                  <span className="shrink-0">{status.label}</span>
                  {/* Status dot rides WITH the state word it describes, rather than
                      next to the title where it read as decoration. */}
                  <span
                    className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status.dot, status.pulse && 'animate-pulse')}
                    aria-label={status.label}
                  />
                  <span className="shrink-0 text-muted-foreground/40">·</span>
                  {/* Which backend is actually running this session. Sits left of
                      ctx because both describe the run, not the conversation.
                      Short labels — the meta line is already tight at 390px.
                      Also the way IN to the session detail: the backend is the
                      thing you'd click this line to change. */}
                  <button
                    type="button"
                    onClick={() => setDetailOpen(true)}
                    title={backendTitle}
                    aria-label="session details"
                    className="shrink-0 font-mono rounded px-1 -mx-1 cursor-pointer transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    {backendLabel}
                  </button>
                  <span className="shrink-0 text-muted-foreground/40">·</span>
                  {/* Full bar (count + 56px track + percent) is ~130px and crowded a
                      390px header; mobile gets `mini` — same token count, shorter
                      track, no percent. */}
                  <span className="sm:hidden shrink-0">
                    <CtxBar
                      tokens={session.contextTokens}
                      total={contextWindowFor(session.runtime, session.runtimeModel)}
                      variant="mini"
                    />
                  </span>
                  <span className="hidden sm:inline-flex shrink-0">
                    <CtxBar
                      tokens={session.contextTokens}
                      total={contextWindowFor(session.runtime, session.runtimeModel)}
                    />
                  </span>
                </>
              )}
              {session?.closedAt && <><span className="text-muted-foreground/40">·</span><span className="text-muted-foreground">closed</span></>}
            </div>
          </div>
        </div>
        <div ref={moreRef} className="relative flex items-center gap-1 shrink-0">
          {/* The way out of an archived chat. Persistent (never in the phone's
              overflow tray) and tinted, because for a closed session it is the only
              action that does anything — everything else here is disabled, and the
              composer just says "session is closed". */}
          {session?.closedAt && (
            <button
              type="button"
              onClick={() => reopenSession.mutate({ id: sessionId })}
              disabled={reopenSession.isPending}
              aria-label="restore from archive"
              title="Restore from archive — bring this chat back into the sidebar. It stays asleep until your next message, which wakes it with full history (--resume)."
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 transition-colors cursor-pointer hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-wait"
            >
              <ArchiveRestore className="h-4 w-4" />
            </button>
          )}
          {/* Secondary actions. Inline while the header (container query — the
              chat COLUMN, which the preview split narrows) is ≥40rem; below
              that they live in the tray, same JSX in a different container. */}
          <div className="hidden @min-[40rem]:flex items-center gap-1">{secondaryActions}</div>
          {/* Narrow tray (phones AND a squeezed split column): anchored to the
              LEFT of the persistent buttons and floated over the title
              (right-full + its own opaque background), so opening it costs no
              header width. */}
          <div
            className={cn(
              '@min-[40rem]:hidden absolute right-full top-1/2 -translate-y-1/2 mr-1 z-20 flex items-center gap-1',
              'rounded-lg border border-border bg-popover/95 px-1 py-0.5 shadow-lg backdrop-blur-sm',
              'origin-right transition-[opacity,transform] duration-200 ease-out',
              moreOpen
                ? 'opacity-100 translate-x-0 scale-100'
                : 'pointer-events-none opacity-0 translate-x-2 scale-95',
            )}
            aria-hidden={!moreOpen}
          >
            {secondaryActions}
          </div>
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label={moreOpen ? 'hide more actions' : 'more actions'}
            title="More actions"
            className={cn(
              '@min-[40rem]:hidden inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors cursor-pointer',
              moreOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {moreOpen ? <ChevronRight className="h-4 w-4" /> : <MoreHorizontal className="h-4 w-4" />}
          </button>
          {/* pi and codex sessions run as child processes with no tmux pane —
              the terminal link would attach to a pane that does not exist.
              `session.runtime` is the RESOLVED backend (getSession/listSessions
              spread it over the row), so an inherited default counts too. */}
          {!scope.scoped && hasTmuxPane(session?.runtime) && (
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
            icon={Trash2}
            danger
            title="move this session to the recycle bin"
            busy={deleteSession.isPending}
            disabled={!session}
            onConfirm={() => deleteSession.mutate({ ids: [sessionId], reason: 'manual' })}
          />
        </div>
      </div>

      {findOpen && (
        <ChatFind sessionId={sessionId} getViewport={getViewport} onJump={anchored.jumpTo} onClose={() => setFindOpen(false)} />
      )}

      {/* Mounted only once opened, so an untouched chat never pays for the
          detail query; kept mounted afterwards so the sheet animates out. */}
      {(detailOpen || detailEverOpened.current) && (
        <SessionDetailSheet sessionId={sessionId} open={detailOpen} onOpenChange={setDetailOpen} />
      )}

      {/* Anchored mode banner: you're parked on a search hit, not at the live
          tail. Without this the frozen timeline reads as a stuck session. */}
      {anchored.active && (
        <div className="shrink-0 flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 h-9 text-xs">
          <span className="text-amber-700 dark:text-amber-400">Viewing earlier history</span>
          <button
            type="button"
            onClick={anchored.clear}
            className="ml-auto rounded-md px-2 py-1 text-muted-foreground transition-colors cursor-pointer hover:bg-accent hover:text-foreground"
          >
            Jump to latest ↓
          </button>
        </div>
      )}

      <ScrollArea ref={scrollRef} className="flex-1 min-h-0 bg-background">
        {/* overflow-x-clip guarantees the conversation never scrolls sideways as
            a whole; wide content (tables, code) scrolls within its own message.
            `clip` (not hidden) avoids forcing overflow-y to auto. */}
        <div className="px-4 py-4 max-w-3xl mx-auto overflow-x-clip [overflow-anchor:none]">
          {(anchored.active ? anchored.loading : messages.isPending && !baseRows) ? (
            <Skeleton className="h-32" />
          ) : view.length === 0 ? (
            <EmptyChat agentName={session?.agentName} onPickPrompt={pickPrompt} />
          ) : (
            <>
              {anchored.active ? (
                anchored.hasBefore && (
                  <div className="flex justify-center pb-3">
                    <button
                      type="button"
                      onClick={anchored.loadEarlier}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors cursor-pointer hover:border-foreground/30 hover:text-foreground hover:bg-accent/40"
                    >
                      ↑ load earlier
                    </button>
                  </div>
                )
              ) : (
                older.hasMore && (
                <div className="flex justify-center pb-3">
                  <button
                    type="button"
                    onClick={loadEarlier}
                    disabled={older.loading}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors cursor-pointer hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 disabled:cursor-wait disabled:opacity-50"
                  >
                    {older.loading ? 'loading…' : '↑ load earlier'}
                  </button>
                </div>
                )
              )}
              {summaryMode && view.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground py-8">
                  Replies only · this turn is still running, no final reply yet
                </p>
              ) : (
                <MessageTimeline messages={view} streamingTailId={streamingTailId} dotClass={status.dot} getViewport={getViewport} />
              )}
            </>
          )}
          {/* Only show the standalone dots-below indicator while the assistant
              has not yet emitted any content. Once the bubble appears, dots
              live inline at the bubble's tail (StreamingDots). */}
          {showThinkingDots && !streamingTailId && <TypingIndicator dot={status.dot} />}
        </div>
      </ScrollArea>
      {/* Floating controls, in one zero-height strip above the ComposeBar so they
          stack instead of overlapping: Stop while a turn runs, scroll-to-latest
          when you've scrolled up. Pointer-events gated so the strip never catches
          clicks meant for the conversation behind it. */}
      {(showStopPill || (!pinnedToBottom && (messages.data?.length ?? 0) > 0)) && (
        <div className="relative h-0 z-10 pointer-events-none">
          {!pinnedToBottom && (messages.data?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              aria-label="scroll to latest"
              className={cn(
                'pointer-events-auto absolute left-1/2 -translate-x-1/2',
                showStopPill ? 'bottom-12' : 'bottom-3',
                'inline-flex items-center gap-1 rounded-full border border-border bg-background/95',
                'px-3 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur',
                'hover:bg-accent hover:text-foreground transition-colors cursor-pointer',
              )}
            >
              <span aria-hidden="true">↓</span> latest
            </button>
          )}
          {showStopPill && (
            <StopPill onStop={() => cancelTurn.mutate({ sessionId })} stopping={cancelTurn.isPending} />
          )}
        </div>
      )}

        {/* The mic floats alone. Takeover moved into the suggestion row above the
            composer — it's a decision you make instead of typing, not something you
            reach for mid-scroll. */}
        {(showMicFab || hasLivePreview) && (
          <FabDock count={(showMicFab ? 1 : 0) + (hasLivePreview ? 1 : 0)}>
            {showMicFab && (
              // Never hidden while a run is live: the button IS the way out of
              // one (release it, or tap it), and a button that unmounts
              // mid-press never delivers its pointerup.
              <VoiceMic
                hidden={false}
                dictating={dictating}
                cancelArmed={slideCancelArmed}
                onDictate={startDictation}
                onDictateStop={stopDictation}
                onDictateCancel={cancelDictation}
                onSlideCancelArm={setSlideCancelArmed}
              />
            )}
            {/* Below the mic so the mic keeps its stored spot; only exists while
                the session has a registered preview — "hidden by default". */}
            {hasLivePreview && (
              <PreviewFab open={previewOpen} onToggle={() => setPreviewOpenUrl(previewOpen ? null : (livePreview?.url ?? null))} />
            )}
          </FabDock>
        )}
        {/* Plain wrapper — it used to be measured to keep the mic above this stack.
            The mic goes wherever it's dragged now; the div stays because it's one
            flex item, and unwrapping it would respace the whole control column. */}
        <div>
          <LoopBar
            loopState={sessionOne.data?.loopState}
            onStartLoop={startLoop}
            onStartCron={startCron}
            onStartAutonomy={startAutonomy}
            takeover={
              showTakeover
                ? {
                    active: takenOver,
                    busy: requestTakeover.isPending || releaseTakeover.isPending,
                    onToggle: () =>
                      takenOver
                        ? releaseTakeover.mutate({ sessionId, reason: 'human' })
                        : requestTakeover.mutate({ sessionId }),
                  }
                : null
            }
            disabled={!!session?.closedAt}
            sessionId={sessionId}
          />
          {/* Directly above the composer: the Brain's stated goal sits where the
              human's eyes already are when they're about to type — which is also
              the gesture that takes the conversation back. */}
          {takenOver && takeover && (
            <TakeoverBar
              goal={takeover.takeoverGoal}
              turns={takeover.takeoverTurns}
              agentName={session?.agentName ?? 'the agent'}
              agentWorking={session?.state === 'working'}
              brainWorking={takeover?.takeoverBrainState === 'working'}
              drafting={!!takeover?.takeoverDraft}
              releasing={releaseTakeover.isPending}
              onRelease={() => releaseTakeover.mutate({ sessionId, reason: 'human' })}
            />
          )}
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
          <DictationDock
            ref={dictationRef}
            sessionId={sessionId}
            composerRef={composerRef}
            cancelArmed={slideCancelArmed}
            onActiveChange={onDictationActive}
            onNotice={setComposerNotice}
          />
          <ComposeBar
            sessionId={sessionId}
            disabled={!!session?.closedAt}
            awaitingInput={!!pendingInteraction}
            sending={send.isPending}
            inFlight={isInFlight}
            queueFull={queueLen >= QUEUE_LIMIT}
            brainDraft={takenOver ? takeover?.takeoverDraft : null}
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
              // Capture the untrimmed draft straight off the textarea (its value
              // lives in ComposeBar now) so a failed send restores it exactly.
              const prevDraft = taRef.current?.value ?? text;
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
              composerRef.current?.clear();
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
                    composerRef.current?.restore(prevDraft);
                    setAttachments(prevAttachments);
                    // Surface WHY (e.g. over the image cap) instead of silently
                    // restoring the draft — the old behavior read as "send is dead".
                    setComposerNotice(err.message || 'Failed to send — please try again.');
                  },
                },
              );
            }}
            ref={composerRef}
            attachments={attachments}
            setAttachments={setAttachments}
            notice={composerNotice}
            setNotice={setComposerNotice}
            taRef={taRef}
            history={sentHistory}
          />
        </div>
      </div>
      {previewOpen && livePreview && (
        <LivePreviewPanel preview={livePreview} onClose={() => setPreviewOpenUrl(null)} />
      )}
      </div>
    </>
  );
}

// Stop, as its own labelled control floating above the composer.
//
// It used to be an unlabelled dark circle INSIDE the composer, in the send
// button's slot — so while a turn ran, the most-tapped pixels in the app stopped
// meaning "send" and started meaning "kill the turn", and with a draft typed the
// two sat side by side as identical circles. Every accidental interrupt we have
// logs for looks like that mis-tap: a turn killed mid-sentence, then a short
// "继续" a minute later. Three things keep this one honest:
//
//   · it is somewhere else entirely — nothing lands in the send column;
//   · it says "Stop", in destructive colours, instead of being a shape;
//   · ARM_MS: a turn can begin under a finger already travelling toward this
//     spot (tapping "↓ latest", dismissing the keyboard), so clicks that arrive
//     within a moment of the pill appearing are ignored. You can only stop a
//     turn by aiming at a pill that was already there.
function StopPill({ onStop, stopping }: { onStop: () => void; stopping: boolean }) {
  const ARM_MS = 400;
  const shownAt = useRef(0);
  useEffect(() => { shownAt.current = Date.now(); }, []);
  return (
    <button
      type="button"
      onClick={() => {
        if (Date.now() - shownAt.current < ARM_MS) return;
        onStop();
      }}
      disabled={stopping}
      aria-label={stopping ? 'stopping' : 'stop this turn'}
      title={stopping ? 'stopping…' : 'stop this turn (Esc)'}
      className={cn(
        'pointer-events-auto absolute left-1/2 -translate-x-1/2 bottom-3',
        'inline-flex items-center gap-1.5 rounded-full border border-rose-500/40',
        'bg-background/95 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur',
        'text-rose-600 dark:text-rose-400 transition-colors cursor-pointer',
        'hover:bg-rose-500/10 disabled:cursor-wait disabled:opacity-60',
      )}
    >
      <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
      {stopping ? 'stopping…' : 'Stop'}
    </button>
  );
}

// Natural-language template the "开启循环任务" suggestion drops into the
// composer. /loop left the slash picker (loops are natural-language now), so
// this guided starter is the entry point. The loop skill matches on 循环/每 X/
// 直到 and sets up a session-scoped recurring task whose every iteration
// streams back into THIS conversation.
const LOOP_TEMPLATE =
  '开启循环任务：每 1 小时，<要做的事>。每轮做完都自己测试验证一遍，再把结果（含验证结论）发到这个对话；达成 <完成条件> 后自动停止。';

// Cron sibling of LOOP_TEMPLATE. The cron skill matches on 定时/每 X/cron and creates
// a DURABLE background task via mcp__hermit__cron_create. What separates it from a
// loop is no longer "where the result goes" — a cron now reports into the chat that
// created it too — it's that each run is an ISOLATED turn, so a daily job never grows
// this conversation's context, and it survives restarts.
//
// Prompt templates stay in Chinese on purpose: they are typed at the AGENT, and the
// English rule covers the product's own UI, not what you say to an agent.
const CRON_TEMPLATE =
  '开启定时任务：每 60 分钟（时间上下浮动 ±10 分钟），<要做的事>。每次独立后台运行（不占用本对话上下文），跑完把结果发回这个对话，完整历史在 /cron 页面。';

// One-shot autonomy nudge (NOT a recurring task): tells the agent to proceed with
// its own recommendation and stop asking for confirmation until the work is done.
// Dropped by the "Run to done" suggestion — no cadence, so it doesn't trip the
// loop/cron skills; it's a plain directive for the current task.
const AUTONOMY_TEMPLATE = '按照你的推荐做，不再询问我，直到做完。';
