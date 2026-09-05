'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, Suspense, lazy } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  RotateCw, Trash2, Terminal, Pencil, Search, FoldVertical, Sparkles,
  MoreHorizontal, ChevronRight, SquarePen, Info, ArchiveRestore, Eye,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  pruneToLive,
  queueCancelTarget,
  queueDisplay,
  queueIsFull,
  queuePollMs,
} from '@/components/chat/queue-core';
import { CtxBar } from '@/components/ctx-bar';
import { contextWindowFor } from '@/lib/context-window';
import { chatHeaderTitle } from '@/lib/chat-header';
import {
  sessionStatusView, mergeLiveStatus, workingUnconfirmed, isRestingState,
  type LiveStatusFrame,
} from '@/lib/session-status';
import { dashboardReach } from '@/lib/dashboard-reach';
import { useMarkSessionRead } from '@/lib/session-read';
import { lastSessionId, rememberSession } from '@/lib/last-session';
import { writeCachedSessions } from '@/lib/session-list-cache';
import { isOptimisticTrash } from '@/lib/optimistic-trash';
import {
  markSessionWorking,
  publishSessionStatus,
  clearSessionStatus,
  STATUS_REFRESH_MS,
  type LiveStatus,
} from '@/lib/session-live';
import { authedFetch } from '@/lib/asst-fetch';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { useScope } from '@/lib/use-scope';
import { ScheduleBar } from '@/components/chat/schedule-bar';
import { TakeoverBar } from '@/components/chat/takeover-bar';
import { BackgroundBar } from '@/components/chat/background-bar';
import { useLiveActivity } from '@/components/chat/use-live-activity';
import { msgText, isHarnessTerminator, type Attachment } from '@/components/chat/lib';
import { ChatFind } from '@/components/chat/chat-find';
import { Collapse } from '@/components/chat/collapse';
import { useAnchoredWindow } from '@/components/chat/use-anchored-window';
import { useOlderPages, shedRows, shouldKeepShed, type TimelineRow } from '@/components/chat/use-older-pages';
import { usePrependAnchor } from '@/components/chat/use-prepend-anchor';
import { useScrollStability } from '@/components/chat/use-scroll-stability';
import { isVerticalWheelInput, readerMovedUp } from '@/components/chat/scroll-stability-core';
import { dropLanded, stopPill, turnInFlight } from '@/components/chat/composer-core';
import { useCachedTimeline, useTimelineWriteThrough } from '@/lib/chat-cache/use-chat-cache';
import { applyMessagePush, foldPushes, type PushFrame } from '@/lib/chat-cache/merge-messages';
import { ConfirmIconButton } from '@/components/chat/confirm-icon-button';
import { EmptyChat } from '@/components/chat/empty-chat';
import { TypingIndicator } from '@/components/chat/message-bits';
import { MessageTimeline } from '@/components/chat/message-timeline';
import { readTranslatePrefs } from '@/lib/translate-prefs';
import { translateOutgoing } from '@/lib/translate-outbound';
import { RunDetailContext, stepsFromRows, type RunResolver } from '@/components/chat/run-capsule';
import { isMachineryBlock } from '@/components/chat/fold-runs';
import { ComposeBar, MicHintBar, QueueBar, type ComposerHandle } from '@/components/chat/composer';
import type { DictationHandle, DictationSource } from '@/components/chat/dictation-dock';
import { parseLivePreview } from '@/lib/live-preview';
import { usePreviewSwipe } from '@/components/chat/use-preview-swipe';
import { SLIDE_MS as PREVIEW_SLIDE_MS } from '@/components/chat/preview-drag';
import { INITIAL_WINDOW, timelineQueryInput, timelineStreamParams } from '@/lib/chat-window';
import { readCachedSessions } from '@/lib/session-list-cache';
import { ModelChip } from '@/components/chat/model-chip';
import { runtimeShortLabel, runtimeDetail, hasTmuxPane, providerMark } from '@/lib/runtime-labels';
import { formatPreviewElementPick, type PreviewElementPick } from '@/components/chat/preview-element-pick';

// isTouchPrimary (phone/tablet vs desktop) lives in @/lib/save-file — the
// soft-keyboard return key inserts a newline there (a dedicated send button
// handles sending), and the same gate drives the share-vs-download save path.


// How long the message pane keeps re-asserting the bottom after its size
// changes. Covers a multi-step composer growth (each new line is its own resize,
// and the browser's own scroll adjustment lands a frame later).
const SETTLE_AFTER_RESIZE_MS = 400;

// Ceiling on stream frames held while the first window fetch is still in
// flight (see heldPushesRef). Reached only if that fetch never settles, in
// which case the oldest frames are also the least likely to still matter.
const HELD_PUSH_LIMIT = 200;

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
// re-renders (markdown re-parse + highlight.js) ~4×/sec. applyMessagePush merges
// by id and keeps the previous object for every unchanged row — see
// lib/chat-cache/merge-messages, which also owns the delta/gone semantics the
// stream pushes in.

// The "New chat" screen, split out behind React.lazy. It is a BRANCH you have to
// click into (?new=1 / ?agent=…) — the normal /chat landing renders SessionPane —
// yet it was the only static path from this module to @/components/ui/select, and
// base-ui's Select drags its popup + floating-position engine along as a 136 KB
// chunk. That chunk sat on the blocking script list of /chat, /brain and
// /brain/dispatch (the three heaviest routes; /brain re-exports SessionPane from
// here) for a form most page loads never show. Warmed on idle in ChatPageInner
// below, so clicking New chat still finds it in cache.
const NewChatPane = lazy(() => import('@/components/chat/new-chat-pane').then((m) => ({ default: m.NewChatPane })));

// Same treatment for the other low-frequency branches of this page: the detail
// sheet, the live-preview UI and voice dictation are all conditional panels a
// plain page load never renders, yet their code sat in the blocking first-load
// chunk. Each renders inside its own <Suspense fallback={null}> below — showing
// up a frame late is fine for a panel — and all five chunks are warmed on idle
// in ChatPageInner, the same way NewChatPane is. parseLivePreview (used during
// render) moved to lib/live-preview so this module keeps no static path into
// preview-panel.
const SessionDetailSheet = lazy(() => import('@/components/chat/session-detail-sheet').then((m) => ({ default: m.SessionDetailSheet })));
const LivePreviewPanel = lazy(() => import('@/components/chat/preview-panel').then((m) => ({ default: m.LivePreviewPanel })));
const PreviewTab = lazy(() => import('@/components/chat/preview-tab').then((m) => ({ default: m.PreviewTab })));
const DictationDock = lazy(() => import('@/components/chat/dictation-dock').then((m) => ({ default: m.DictationDock })));

// Shown only while that chunk is in flight. Mirrors the pane's own frame (header
// + centered max-w-md card) so the swap doesn't move anything; the mobile sidebar
// toggle stays live so the screen is never a dead end.
function NewChatFallback() {
  return (
    // min-h-0 for the same reason as the real pane's root — see there.
    <div className="flex flex-1 flex-col min-h-0">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">New chat</span>
      </header>
      {/* Same scroll frame as the real pane, not just the same card — so the
          swap cannot move anything, and so the next person to copy this block
          copies the version that survives a long backend list. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col p-6">
        <div className="w-full max-w-md mx-auto my-auto rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm" aria-hidden="true">
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

  // Warm the split chunks on idle — same trick markdown.tsx uses. It is off the
  // critical path (fires after first paint, at idle priority) but lands well before
  // the New chat button (or the detail sheet, preview, mic) gets clicked, so the
  // splits above cost no perceived latency.
  // Lives HERE rather than at module scope on purpose: /brain imports SessionPane
  // from this file and never shows the pane, so it should not pay for the fetch.
  useEffect(() => {
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void };
    const warm = () => {
      void import('@/components/chat/new-chat-pane');
      void import('@/components/chat/session-detail-sheet');
      void import('@/components/chat/preview-panel');
      void import('@/components/chat/preview-tab');
      void import('@/components/chat/dictation-dock');
    };
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
    // An optimistic sidebar trash removes the OPEN session from the list in
    // the same beat that it SPA-navigates to the next one (recent-lists.tsx
    // marks the id via lib/optimistic-trash). Without this grace the stale
    // branch below wins the race with a window.location hard nav and
    // white-screens the page the replace would have painted fine. Defer; if
    // the URL still points at the tombstoned id after 800ms the replace
    // really was swallowed (the documented Next 16 same-path case) and the
    // hard nav fires as the safety net it always was.
    if (stale && isOptimisticTrash(sessionParam)) {
      const tombstoned = sessionParam;
      const timer = setTimeout(() => {
        if (
          isOptimisticTrash(tombstoned) &&
          new URLSearchParams(window.location.search).get('session') === tombstoned
        )
          window.location.href = '/chat';
      }, 800);
      return () => clearTimeout(timer);
    }
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

// Composer draft state + per-session localStorage persistence now live IN
// ComposeBar (components/chat/composer.tsx) so a keystroke re-renders only the
// composer, not this whole pane. SessionPane's occasional draft writes go
// through the imperative ComposerHandle (composerRef) below.

// How far above the top of the list a "load earlier" fires. Two screens of
// runway, floored so a short viewport (a phone with the keyboard up) still gets
// a useful lead. Kept as a function of the CURRENT viewport height rather than a
// constant: the composer grows and the keyboard opens, and a fixed margin that
// felt right at 900px is most of the screen at 300px.
function pullMargin(clientHeight: number): number {
  return Math.max(400, clientHeight * 2);
}

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
  // the gap-filler for the header AND the source of per-session state the slimmed
  // 5s listSessions payload deliberately leaves out (P1-2). It polls at 5s; a
  // single-row PK query, so the extra poll is cheap and only runs on /chat.
  const sessionOne = trpc.chat.getSession.useQuery({ sessionId }, { enabled: !!sessionId, staleTime: 30_000, refetchInterval: 5_000 });
  // Last resort for the first frame of a MACHINE switch, which is a full
  // document navigation: React Query starts empty, so both queries above are a
  // round trip away (~108 ms of Mac→VPS floor before either can answer) and the
  // header showed a raw id with the composer disabled for that whole time. The
  // row is already sitting in localStorage — the sidebar has been writing it
  // there for exactly this reason — so read it synchronously during the first
  // render.
  //
  // Ordered strictly worst-last: a real list row wins, then the real single-row
  // fetch, then the snapshot. That ordering is the whole safety argument — the
  // snapshot can be seconds stale and must never outrank something fetched.
  type SessionListRow = NonNullable<typeof sessionMeta.data>[number];
  const cachedSessionRow = useMemo(
    () => readCachedSessions<SessionListRow>()?.find((s) => s.id === sessionId),
    [sessionId]
  );
  const session = sessionMeta.data?.find((s) => s.id === sessionId) ?? sessionOne.data ?? cachedSessionRow ?? undefined;
  // Live updates arrive via SSE (/api/chat/stream), written straight into this
  // query's cache. The poll below is only a fallback for when the stream isn't
  // connected (the gateway flushes block-level rows into Postgres either way).
  const [streamConnected, setStreamConnected] = useState(false);
  // The session's runtime state as the stream last pushed it (`event: status`).
  // Same fields as the polled row, merged by `snapshotAt` — see mergeLiveStatus.
  // This is what turns a turn boundary from "up to 13s away" (8s gateway tick +
  // 5s browser poll) into "as fast as the gateway's POST", and it is why the
  // header no longer has to lean on guesses that lapse mid-turn.
  const [pushedStatus, setPushedStatus] = useState<LiveStatusFrame | null>(null);
  // Fixed live window — see INITIAL_WINDOW. Older history lives in `older`.
  const limit = INITIAL_WINDOW;
  const [findOpen, setFindOpen] = useState(false);
  // Live preview (hermit-preview CLI → gateway preview module → livePreview
  // column). Sourced from the single-row getSession poll — the merged `session`
  // row may come from listSessions, which deliberately never carries it.
  const livePreview = parseLivePreview(sessionOne.data?.livePreview);
  // The URL the user opened the panel FOR. Open-ness is derived from identity
  // rather than a boolean an effect has to reset: a withdrawn or replaced
  // registration stops matching and the panel closes by construction.
  const [previewOpenUrl, setPreviewOpenUrl] = useState<string | null>(null);
  // The panel animates BOTH ways, so closing cannot just unmount it. `shown`
  // drives the travel; the url keeps it mounted until the travel is over — for
  // exactly PREVIEW_SLIDE_MS, the same constant the panel's CSS transition and
  // both of its drag paths use.
  const [previewShown, setPreviewShown] = useState(false);
  const previewExit = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The exact input the sidebar's hover-prefetch uses — see lib/chat-window.
  const timelineInput = useMemo(() => timelineQueryInput(sessionId), [sessionId]);
  const messages = trpc.chat.listMessages.useQuery(
    timelineInput,
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
  type WindowRow = NonNullable<typeof messages.data>[number];
  // Stream pushes that arrived before this window's first fetch answered, held
  // rather than written — see foldPushes, and the flush effect below the cache
  // hook that owns letting them go. Capped so a query that never settles can't
  // grow this without bound; the oldest frames are the ones the query's own
  // result is most likely to already contain.
  const heldPushesRef = useRef<PushFrame<WindowRow>[]>([]);

  // ── Live updates via Server-Sent Events ──────────────────────────────────
  // Stream the message list as it changes and write each push into the query
  // cache, so all downstream logic (streaming detection, scroll, typewriter)
  // keeps reading `messages.data` unchanged. fetch()+ReadableStream (not
  // EventSource) so we can send the x-asst-key header. Falls back to the poll
  // above if the stream drops.
  useEffect(() => {
    // Belongs to the session this stream is about to open. SessionPane is reused
    // across session switches without a key, so without this the previous
    // conversation's status would drive this one's header until the first frame.
    setPushedStatus(null);
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
    // How long the optimism below is allowed to suppress the fallback poll. A
    // healthy handshake resolves in ~10ms; anything past this is a stall, and a
    // stall must hand the poll back rather than freeze the list.
    const HANDSHAKE_GRACE_MS = 2_000;

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
      // The optimism is a loan, not a gift. It is worth making while the
      // handshake behaves; when the handshake does NOT complete, the poll is off
      // and nothing is pushing, so the conversation stops updating with no
      // symptom anywhere else on the page — the status chip keeps polling over
      // its own query and cheerfully reads "ready" next to a reply that has not
      // been fetched. That is exactly what a silent SSE open used to cause (see
      // api/chat/stream's opening byte). Give the fallback back after the grace
      // period; a late-but-successful connect turns it off again below.
      const graceTimer = window.setTimeout(() => {
        if (ctrl === myCtrl) setStreamConnected(false);
      }, HANDSHAKE_GRACE_MS);
      (async () => {
        try {
          // Initial connect skips the initial emit — listMessages already loaded
          // this window (avoids the open-time double-fetch). A RECONNECT does NOT
          // skip: it emits the current window once to catch up on anything that
          // landed during the disconnect gap.
          const res = await authedFetch(`/api/chat/stream?${timelineStreamParams(sessionId, { skipInitial: !isReconnect })}`, {
            signal: myCtrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          clearTimeout(graceTimer);
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
              const lines = frame.split('\n');
              const dataLine = lines.find((l) => l.startsWith('data:'));
              if (!dataLine) continue;
              // Two frame types share this stream now. A frame with no `event:`
              // is a message push — that is what the server sent before the
              // status channel existed, and the shape a `status=0` server still
              // sends.
              const eventName = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? 'messages';
              try {
                // `delta=1` gets {rows, gone}. The bare array is what a server
                // that predates the flag sends, and what a tab still running the
                // previous bundle would ask for — accept both so a deploy never
                // leaves a page silently unable to parse its own stream.
                const frame = JSON.parse(dataLine.slice(5).trim());
                if (eventName === 'status') {
                  setPushedStatus(frame as LiveStatusFrame);
                  continue;
                }
                const rows = Array.isArray(frame) ? frame : frame?.rows ?? [];
                const gone = Array.isArray(frame) ? undefined : frame?.gone;
                // A delta is a fragment, and a fragment written into a cache
                // that has nothing in it becomes the entire timeline. On the
                // first connect the initial full-window emit is skipped, so
                // that empty gap is real — one round trip wide, and a session
                // mid-turn pushes into it. Hold those frames; the effect by the
                // cache hook folds them onto the window the moment it lands.
                // (`[]` is a real answer — an empty session — not a gap.)
                if (utils.chat.listMessages.getData(timelineInput) === undefined) {
                  const held = heldPushesRef.current;
                  held.push({ rows, gone });
                  if (held.length > HELD_PUSH_LIMIT) held.splice(0, held.length - HELD_PUSH_LIMIT);
                } else {
                  utils.chat.listMessages.setData(timelineInput, (prev) => applyMessagePush(prev, rows, gone));
                }
              } catch { /* ignore a malformed frame */ }
            }
          }
        } catch {
          /* network error / abort / zombie-kill — reconnect below takes over */
        } finally {
          clearTimeout(graceTimer);
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
      // Held frames belong to the window this stream was reading. Another
      // session's window must never inherit them.
      heldPushesRef.current = [];
    };
  }, [sessionId, timelineInput, utils]);

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
  //
  // Optimistic like the sidebar's delete (recent-lists.tsx): the row leaves
  // the cached list and the localStorage snapshot NOW, so the reload above
  // lands on a warm list that no longer contains the dead row — without this
  // the snapshot's 20s throttle made the first paint flash it back.
  const deleteSession = trpc.chat.trashSessions.useMutation({
    onMutate: async ({ ids }) => {
      await utils.chat.listSessions.cancel({});
      const prev = utils.chat.listSessions.getData({});
      const next = prev?.filter((s) => !ids.includes(s.id));
      utils.chat.listSessions.setData({}, next);
      if (next) writeCachedSessions(next, true);
      return { prev };
    },
    onError: (_e, _v, context) => {
      if (context?.prev) {
        utils.chat.listSessions.setData({}, context.prev);
        // onMutate force-wrote the filtered list; put the row back in the
        // snapshot too, or the next full reload's first paint drops it.
        writeCachedSessions(context.prev, true);
      }
    },
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
  // Outgoing sends are issued through this chain so they reach the server in the
  // order they were typed. Only matters with outgoing auto-translate on: that
  // send waits ~0.4s for the translation, and an untranslated message typed
  // straight after would otherwise overtake it and land first.
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  // Realtime dictation lives in its own component so the text arriving
  // ~36×/second re-renders the composer's own draft and nothing else. It draws
  // nothing, and nothing up here needs to know it is running — the composer
  // lights its own mic. All that reaches here is a ref to start / stop / cancel.
  const dictationRef = useRef<DictationHandle>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Composer notice line: attachment-cap warnings (set in ComposeBar.addFiles) AND
  // send failures (set in onSend's onError) — so a rejected send explains itself
  // instead of silently restoring the draft.
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  // Mic permission chatter. Produced in the composer (it owns the gesture),
  // shown above the suggestion chips — see MicHintBar for why up there.
  const [micHint, setMicHint] = useState<string | null>(null);
  // Optimistic outbound messages — render the user's bubble instantly on send so
  // it doesn't wait for the send round-trip + SSE echo (~200ms). Kept in a SEPARATE
  // overlay (NOT the query cache): the cache holds server rows keyed by server id,
  // and an optimistic row has neither — a full-window refetch drops it, and a
  // delta push has nothing to match it against. Merged into `view` at
  // render-time and auto-dropped once the real row (same text) lands in the cache.
  const [pending, setPending] = useState<Array<{ id: string; realId?: string; role: 'user'; content: { type: 'text'; text: string }[]; createdAt: string }>>([]);
  // Inline-edit the session title from the header. Clicking the title swaps
  // it for an input; Enter or blur saves, Escape cancels. Backend already has
  // `chat.setTitle` — we just plug into it.
  const [editingTitle, setEditingTitle] = useState(false);
  // Mobile header overflow: the phone header only has room for the actions you
  // actually reach for mid-conversation (new chat, tmux, delete), so the rest
  // live in a tray that slides out leftward OVER the title. Desktop keeps
  // everything inline.
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
  // Assigned from `anchored.active` further down, where that hook runs.
  const anchoredActiveRef = useRef(false);
  // True while WE scroll programmatically, so the scroll listener doesn't misread
  // the in-between position and unpin the user mid-follow.
  const autoScrollRef = useRef(false);
  // Viewport height as of the last scroll event — how the scroll listener tells
  // "the pane resized under me" from "the user scrolled".
  const lastClientHeightRef = useRef(0);
  // Reader-only coordinate as of the last scroll event, so app compensation and
  // its later physical settlement cannot be mistaken for either direction.
  // Only an upward reader move means "I want to read history".
  const lastScrollTopRef = useRef(0);
  // While the pane is settling after a size change, the bottom is re-asserted
  // every frame and NOTHING is read as user intent. Needed because a composer
  // growth does not land in one step: the stick takes, and then the browser
  // pulls scrollTop back by the exact height the composer gained — which is
  // indistinguishable, event-by-event, from the user scrolling up.
  //
  // Two different questions were being asked of one timestamp, and only one of
  // them is about the pane changing size:
  //
  //   · paneResizedUntilRef — "the viewport just changed height under us, so
  //     nothing that arrives right now is a statement of intent". Refreshed ONLY
  //     by a viewport resize.
  //   · contentMovingUntilRef — "the conversation is still growing". Refreshed
  //     by ANY height change, and used to decide whether a scroll-to-bottom has
  //     to chase an end that keeps moving.
  //
  // Sharing one ref made every streaming reply look like a pane resize. A reply
  // grows the content several times a second, each growth pushed the window
  // 400ms further out, so the window stood open from the first token to the
  // last — and inside it the scroll handler returns early, re-pinning a pinned
  // reader on every scroll event and never reading their intent. The user
  // scrolled up during a reply and was put back at the bottom, every time,
  // for as long as the reply lasted.
  const paneResizedUntilRef = useRef(0);
  const contentMovingUntilRef = useRef(0);
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
  const scrollStability = useScrollStability(getViewport);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = getViewport();
    if (!el) return;
    autoScrollRef.current = true;
    // The honest end, not el.scrollHeight: with a downward correction held, the
    // raw value is inflated by the transform's own size, and landing there and
    // being re-clamped once the transform goes is a visible second jump.
    scrollStability.scrollTo(scrollStability.maxScrollTop(), behavior, 'latest-button');
    setPinned(true);
    // A smooth scroll animates toward the offset captured RIGHT NOW. Fine on a
    // settled conversation — but while a reply streams in, the bubble keeps
    // growing under the animation and it lands short of the end, by more than
    // the scroll listener's 60px slack, so nothing re-pins and the pill the user
    // just clicked stays on screen. Chase the end for the length of the
    // animation, but only when the content is known to be moving (the
    // sticky-bottom observer refreshed this window within the last
    // SETTLE_AFTER_RESIZE_MS) — an idle conversation keeps its smooth glide.
    if (Date.now() <= contentMovingUntilRef.current) {
      contentMovingUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
      settleKickRef.current?.(SETTLE_CHASE_FRAMES);
    }
    requestAnimationFrame(() => { autoScrollRef.current = false; });
  }, [getViewport, scrollStability, setPinned]);

  // ── Local cache: first paint from disk, and the write-through that fills it ──
  // `cachedRows` is null until the IndexedDB lookup resolves, [] when there's
  // nothing stored. Only used while the server query is still pending — once
  // real data lands it always wins, so a stale cache can never mask live state.
  // Only worth reading when the server window is not already in hand. On the
  // desktop path the sidebar's hover prefetch has usually put it there before
  // the click, and this read cannot change what renders (see `windowRows`
  // below) — it would only take main thread away from the markdown parse that
  // is painting. SessionPane is keyed by sessionId, so a fresh mount's
  // `messages.data` is either a real cache hit or undefined; keepPreviousData
  // has no previous observer to carry anything over from.
  const cachedRows = useCachedTimeline(sessionId, !messages.data);
  useTimelineWriteThrough(sessionId, messages.data);
  const windowRows = useMemo(
    () => messages.data ?? (cachedRows && cachedRows.length > 0 ? cachedRows : undefined),
    [messages.data, cachedRows]
  );

  // Let the held stream frames go (see heldPushesRef). Two ways out:
  //
  //  · the window landed — fold them onto it, newest frame winning, so the
  //    rows that arrived during the fetch are on screen in the SAME paint as
  //    the window itself rather than a frame later;
  //  · the fetch gave up (no data, not fetching, errored) — there is no window
  //    coming, so fold them onto whatever the local cache restored instead.
  //    Holding past that point would leave the reader watching a transcript
  //    that has visibly stopped moving while the stream is still pushing.
  //
  // A layout effect: it runs in the same commit that first renders the window.
  const streamStalled = messages.data === undefined && !messages.isFetching && messages.isError;
  useIsoLayoutEffect(() => {
    if (heldPushesRef.current.length === 0) return;
    if (messages.data === undefined && !streamStalled) return;
    const held = heldPushesRef.current;
    heldPushesRef.current = [];
    // The disk cache stores createdAt as a string; the query window holds Dates.
    const restored: WindowRow[] | undefined = cachedRows?.map((r) => ({
      id: r.id, role: r.role, content: r.content,
      createdAt: new Date(r.createdAt), authoredBy: r.authoredBy ?? null,
    }));
    utils.chat.listMessages.setData(timelineInput, (prev) => foldPushes(prev ?? restored, held));
  }, [messages.data, streamStalled, cachedRows, sessionId, timelineInput, utils]);

  // Older history, paged separately from the live window and served from the
  // local cache whenever it has the page. See use-older-pages.ts.
  const older = useOlderPages(sessionId, windowRows?.[0], (messages.data?.length ?? 0) >= limit);
  // The two arrays below are concatenated with nothing checking that they meet.
  // They stop meeting on their own: the live window is a fixed 60 rows that
  // slides forward as a turn works, `older.rows` stays anchored where the window
  // started, and every row shed in between is deleted from the query cache with
  // nothing left holding it. Nothing looks wrong — the timeline just closes over
  // the missing middle, and paging only walks backwards from the OLDEST row on
  // screen, so no amount of scrolling brings it back. Measured on a live
  // session: 162 messages and fifteen minutes gone, the auto-compaction notice
  // among them, on a tab that had been open through the session's busy stretch.
  //
  // So the shed rows go to the pager instead of the bin — whenever losing them
  // would be visible. A hole in history is one way; the other is the reader
  // having scrolled up, where the shed row's HEIGHT leaves with it and slides
  // everything they are reading up by that much. See shouldKeepShed.
  const absorbOlder = older.absorb;
  const historyOnScreen = older.rows.length > 0;
  const prevWindowRef = useRef<TimelineRow[] | undefined>(undefined);
  useIsoLayoutEffect(() => {
    const prev = prevWindowRef.current;
    prevWindowRef.current = windowRows;
    if (!prev || !windowRows) return;
    const shed = shedRows(prev, windowRows);
    // Before paint, not after. The row leaves the DOM in the same commit that
    // renders the new window, so an absorb a frame later still shows one
    // painted frame with the reader's text already shifted up.
    if (shed.length > 0 && shouldKeepShed({ historyOnScreen, followingTail: pinnedRef.current })) absorbOlder(shed);
  }, [windowRows, absorbOlder, historyOnScreen]);

  const baseRows = useMemo(
    () => (older.rows.length > 0 ? [...older.rows, ...(windowRows ?? [])] : windowRows),
    [older.rows, windowRows]
  );

  // "load earlier" prepends from the top. The reading position is pinned to the
  // message the user was looking at and HELD there while the new history lays
  // out — see use-prepend-anchor.ts for why a one-shot height restore isn't
  // enough.
  // A prepend hold suppresses sticky bottom for its whole life (see toBottom
  // below). Whatever the tail did in the meantime was therefore never chased,
  // so a reader who never left the end can be left short of it with the pin
  // still on — and because the pin is on, no "↓ latest" pill says so either.
  // Measured on a plain open of two live sessions: 126px and 243px short,
  // permanently. One chase when the hold ends closes it.
  const onAnchorRelease = useCallback((mode: 'top' | 'bottom', reason: 'expired' | 'reader-left' = 'expired') => {
    // The anchor watched the reader move more than BOTTOM_SLACK away from the
    // tail, over frames, in reader coordinates. That IS leaving the tail — a
    // better-evidenced verdict than the intent heuristic below, which misses the
    // inputs that raise no pointer/wheel signal at all (keyboard paging, and
    // dragging the scrollbar, whose events land on a SIBLING of the viewport).
    //
    // So drop the pin rather than merely declining to chase. Declining is not
    // enough: sticky bottom acts on the pin every frame on its own, so a reader
    // who dragged the scrollbar 130-250ms after opening — while `pinnedRef` is
    // still stale-true because the scroll listener returns early inside its
    // pane-resize window — got pulled back to the bottom anyway, with no
    // "↓ latest" to say what happened. Measured 11 times out of 11.
    //
    // Clearing the resize window too: that window is what was suppressing the
    // pin update, and it is exactly the thing this verdict overrules.
    if (reason === 'reader-left') {
      paneResizedUntilRef.current = 0;
      if (pinnedRef.current) setPinned(false);
      return;
    }
    // Only a TAIL hold. A hold on a row up in history means the reader was
    // reading history, and pinnedRef can be stale-true there — the scroll
    // listener returns early inside the pane-resize window without ever
    // updating it — so chasing the bottom after one would yank them down.
    if (mode !== 'bottom') return;
    if (!pinnedRef.current || anchoredActiveRef.current) return;
    if (!getViewport()) return;
    contentMovingUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
    settleKickRef.current?.(SETTLE_CHASE_FRAMES);
  }, [getViewport, setPinned]);
  const isFollowingTail = useCallback(() => pinnedRef.current === true, []);
  const prependAnchor = usePrependAnchor(getViewport, scrollStability, onAnchorRelease, isFollowingTail);
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
  // the displaced frame is already on screen. It fires once per committed chunk
  // (`older.rows.length` grows by COMMIT_CHUNK each time, see use-older-pages),
  // so `reassert` lands the correction before paint and `rearm` pushes the
  // settle window out so the still-settling chunk cannot outlive the anchor.
  useIsoLayoutEffect(() => {
    prependAnchor.reassert();
    prependAnchor.rearm();
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
  const anchored = useAnchoredWindow(sessionId, anchorMessageId, getViewport, scrollStability);
  // Read by the sticky-bottom effect, which must not re-subscribe per render.
  // Declared far above, next to pinnedRef, because the prepend anchor's release
  // callback is created before this line and reads it.
  anchoredActiveRef.current = anchored.active;

  // The rendered timeline. Summary mode collapses each turn to its final reply;
  // useMemo keeps the array reference stable between refetches so memo(MessageTimeline) still bails on no-op ticks.
  const view = useMemo(() => {
    if (anchored.active) return anchored.rows ?? [];
    const base = baseRows ?? [];
    if (pending.length === 0) return base;
    // Drop any optimistic row whose real counterpart has landed — matched by
    // the sent row's id, text only as a pre-response fallback (see dropLanded).
    const live = dropLanded(pending, (messages.data ?? []).filter((m) => m.role === 'user'));
    return live.length ? [...base, ...live] : base;
  }, [messages.data, baseRows, pending, anchored.active, anchored.rows]);

  // True while the timeline has nothing to show yet (cold-cache session
  // switch). The skeleton is delayed ~100ms: the IndexedDB cache usually
  // answers in 10–50ms, so an instant skeleton was one white flash the user
  // never needed — data landing first now skips it entirely, and only a
  // genuinely slow load ever shows it.
  const loadingTimeline = anchored.active ? anchored.loading : messages.isPending && !baseRows;
  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (!loadingTimeline) { setShowSkeleton(false); return; }
    const t = setTimeout(() => setShowSkeleton(true), 100);
    return () => clearTimeout(t);
  }, [loadingTimeline]);

  // Top up a timeline too short to scroll.
  //
  // The live window is 60 MESSAGES, and folding turns those into far fewer rows
  // — three quarters of a busy session's messages are tool traffic that now
  // collapses into a handful of capsules. A session can therefore open with less
  // than a screenful and no way to ask for more except the button. So: pull a
  // page whenever there is not enough content to scroll, until there is. Three
  // screens is the target — on a phone the live window folds to as few as four
  // rows, so one screen is not nearly enough to feel like a conversation.
  //
  // Capped rather than looped to exhaustion. Each pass is gated by the same
  // one-at-a-time guard as a user pull, and a page always makes the list longer
  // — but "longer" can be a few pixels if the whole page folds into a capsule
  // that was already there, so an uncapped version would walk a 26k-message
  // session back to its beginning. Five pages of 60 is several screens of
  // anything.
  const topUpsRef = useRef(0);
  useEffect(() => {
    if (anchored.active || !older.hasMore || older.loading) return;
    if (topUpsRef.current >= 5) return;
    const el = getViewport();
    // Honest height: a held downward correction inflates el.scrollHeight by its
    // own size, which would hide a short conversation from the prefill.
    if (!el || scrollStability.contentHeight() > el.clientHeight * 3) return;
    topUpsRef.current += 1;
    const t = setTimeout(() => pullEarlier(), 0);
    return () => clearTimeout(t);
  }, [view.length, older.hasMore, older.loading, anchored.active, getViewport, pullEarlier, scrollStability]);

  // Prune optimistic rows once reflected in the cache so `pending` doesn't grow
  // over a long session. Same-ref return guards against a render loop.
  useEffect(() => {
    if (pending.length === 0) return;
    const userRows = (messages.data ?? []).filter((m) => m.role === 'user');
    setPending((p) => {
      const next = dropLanded(p, userRows);
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
    let deferredBottomTimer: ReturnType<typeof setTimeout> | null = null;
    const toBottom = () => {
      if (!pinnedRef.current || prependAnchorRef.current?.isHolding() || anchoredActiveRef.current) return;
      // Auto-follow never owns a native gesture. During the first 60px away
      // from the tail the pin state intentionally stays true, so a streaming
      // ResizeObserver can otherwise write scrollTop between touch events and
      // cancel WebKit momentum before the intent detector gets to unpin.
      if (scrollStability.isScrolling() && !scrollStability.isProgrammatic()) {
        if (deferredBottomTimer === null) {
          deferredBottomTimer = setTimeout(() => {
            deferredBottomTimer = null;
            toBottom();
          }, 220);
        }
        return;
      }
      autoScrollRef.current = true;
      scrollStability.scrollTo(scrollStability.maxScrollTop(), 'auto', 'sticky-bottom');
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
    // to run every frame until the window expired — and since every resize
    // pushed that 400ms out again, a streaming turn (this observer fires ~4×/s
    // while a reply grows) kept it spinning at frame rate from the first token to
    // the last: measured over a 10s stream, ~210 `scrollHeight` reads and ~370 rAF
    // callbacks against 40 actual content changes, and `get scrollHeight` was the
    // hottest app frame in the whole streaming state. Anything that moves the
    // content later fires the observer again and gets its own burst, and a
    // browser-side scroll adjustment is caught by the scroll listener (which
    // still re-pins for the full pane-resize window — untouched below).
    const SETTLE_FRAMES = 2;
    let framesLeft = 0;     // re-asserts still owed to the last height change
    let raf = 0;            // live settle chain, 0 when idle
    const settle = () => {
      raf = 0;
      if (framesLeft <= 0 || Date.now() > contentMovingUntilRef.current) return;
      framesLeft -= 1;
      if (pinnedRef.current && !prependAnchorRef.current?.isHolding() && !anchoredActiveRef.current) toBottom();
      raf = requestAnimationFrame(settle);
    };
    const kick = (frames: number) => {
      framesLeft = Math.max(framesLeft, frames);
      if (!raf) raf = requestAnimationFrame(settle);
    };
    settleKickRef.current = kick;
    const ro = new ResizeObserver((entries) => {
      if (prependAnchorRef.current?.isHolding()) return; // holding a read position after a prepend
      if (anchoredActiveRef.current) return;   // reading history at a fixed anchor
      // Any height change means the end is moving, and the burst below chases it.
      contentMovingUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
      // Only the VIEWPORT changing height suspends the reading of intent. A
      // reply growing is not the pane moving under anyone, and treating it as
      // one is what made the timeline unscrollable for the length of a turn.
      if (entries.some((e) => e.target === el)) {
        paneResizedUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
      }
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
      if (deferredBottomTimer !== null) clearTimeout(deferredBottomTimer);
      settleKickRef.current = null;
    };
  }, [getViewport, scrollStability]);


  // Track the user's scroll intent. Ignore scrolls WE triggered (autoScrollRef)
  // so an auto-follow never unpins them; a real upward scroll past the slack
  // unpins (and reveals the "scroll to bottom" pill). ~60px slack tolerates
  // small async layout shifts without unpinning.
  useEffect(() => {
    const el = getViewport();
    if (!el) return;
    lastClientHeightRef.current = el.clientHeight;
    lastScrollTopRef.current = scrollStability.readerScrollTop();
    const onScroll = () => {
      // Update the baselines FIRST, even for scrolls we caused — otherwise the
      // next comparison is made against a stale position.
      const logicalSt = scrollStability.logicalScrollTop();
      const readerSt = scrollStability.readerScrollTop();
      // Reader intent already excludes app-owned movement, so no per-event
      // deadband belongs here. WebKit commonly reports a slow drag as 1–2px
      // events; advancing the baseline after each one used to make the whole
      // gesture invisible and let sticky bottom pull it back.
      const wentUp = readerMovedUp(lastScrollTopRef.current, readerSt);
      lastScrollTopRef.current = readerSt;
      const h = el.clientHeight;
      const resized = h !== lastClientHeightRef.current;
      lastClientHeightRef.current = h;
      if (autoScrollRef.current || scrollStability.isProgrammatic()) return;
      const readerTookOver = wentUp && scrollStability.hasUpwardReaderIntent();

      // The pane changed size under us — growing the composer shrinks this
      // viewport from the bottom. That's layout, not a decision to read history.
      // A real touch/wheel/drag wins even inside that protection window. Without
      // this, an immediate upward gesture after sending or resizing the composer
      // was swallowed for 400ms and sticky bottom pulled it back after momentum.
      if (readerTookOver) paneResizedUntilRef.current = 0;
      else if (resized) paneResizedUntilRef.current = Date.now() + SETTLE_AFTER_RESIZE_MS;
      // Inside the settling window nothing is a verdict on intent; the rAF loop
      // started by the ResizeObserver is holding the bottom.
      if (Date.now() < paneResizedUntilRef.current) {
        if (pinnedRef.current) {
          // The sticky-bottom observer owns the physical write and defers it
          // until native scrolling is quiet. This listener only wakes its chase.
          settleKickRef.current?.(SETTLE_CHASE_FRAMES);
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
      // Honest height again: with a downward correction held, el.scrollHeight is
      // inflated by |deviation| while logicalSt is lowered by the same amount,
      // so the raw gap is wrong by twice it — enough to unpin a reader sitting
      // at the tail.
      const gap = scrollStability.contentHeight() - logicalSt - h;
      // The 60px geometry slack must never swallow a real, small upward gesture.
      // Without this reader-intent check, sticky bottom waited for momentum to
      // end and then visibly pulled any sub-60px movement back to the tail.
      if (readerTookOver) setPinned(false);
      // Keep the 60px tolerance only while already following. Once the reader
      // has left, a WebKit bounce inside that band must not silently re-arm the
      // deferred bottom timer; re-pin only at the actual tail.
      else if (gap < 60 && (pinnedRef.current || gap <= 1)) setPinned(true);
      else if (wentUp) setPinned(false);

      // Infinite scroll up: pull the next page of history BEFORE the top is
      // reached. The old trigger was a flat 200px, which is inside one flick —
      // the request left only once the user was already staring at the end of
      // the list, so every gesture ended in a wait. Two viewport heights of
      // runway means the page is normally already prepended by the time the
      // reader gets there, which is the whole difference between this and a
      // native chat app. loadEarlier anchors the scroll so the prepend doesn't
      // yank the viewport.
      if (logicalSt < pullMargin(h)) pullEarlier();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // A scroll event is not enough on its own. Once the viewport is clamped at
    // the top the browser stops firing them, so someone who flings past the top
    // and keeps pushing sits there with nothing happening — the pull that would
    // have fetched the next page never gets a chance to run. The raw gesture
    // still arrives, so use it as the second entry point.
    const onReach = (e: Event) => {
      if (e.type === 'wheel') {
        const wheel = e as WheelEvent;
        if (wheel.deltaY >= 0 || !isVerticalWheelInput(wheel.deltaX, wheel.deltaY, wheel.ctrlKey)) return;
        // At a transform-held physical boundary there may be no scroll event at
        // all. The raw negative wheel is nevertheless an unambiguous request to
        // leave the tail, so disarm sticky bottom before its deferred timer fires.
        if (scrollStability.hasBlockedUpwardIntent()) {
          paneResizedUntilRef.current = 0;
          if (pinnedRef.current) setPinned(false);
        }
      } else if (e.type === 'pointermove') {
        // Mouse movement bubbles through the viewport too. It neither means
        // "load history" nor "leave the tail" unless the controller recorded a
        // real pointer pan that was blocked by transform-held history.
        if (!scrollStability.hasBlockedUpwardIntent()) return;
        paneResizedUntilRef.current = 0;
        if (pinnedRef.current) setPinned(false);
      } else if (scrollStability.hasBlockedUpwardIntent()) {
        // Touch can be clamped before producing even one native scroll event.
        // The stability listener runs first and records this touchmove's raw
        // direction, so the same no-scroll boundary case can still leave tail.
        paneResizedUntilRef.current = 0;
        if (pinnedRef.current) setPinned(false);
      }
      if (scrollStability.logicalScrollTop() >= pullMargin(el.clientHeight)) return;
      pullEarlier();
    };
    el.addEventListener('wheel', onReach, { passive: true });
    el.addEventListener('touchmove', onReach, { passive: true });
    el.addEventListener('pointermove', onReach, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onReach);
      el.removeEventListener('touchmove', onReach);
      el.removeEventListener('pointermove', onReach);
    };
  }, [getViewport, setPinned, pullEarlier, scrollStability]);

  // Hard initial scroll-to-bottom, fired ONCE when the first visible rows land
  // for this session (keyed remount resets the guard). This includes IndexedDB
  // rows: waiting only for the server result let someone start reading the cache
  // and then get yanked to the bottom when the network answered.
  // The RO+pinned chain above follows
  // ongoing growth, but the *initial* anchor is fragile on open: firstScrollRef
  // can be consumed while the list is still empty/pending, and async markdown /
  // image layout (or browser scroll-anchoring) can fire a scroll that unpins
  // before the RO catches up — leaving a fresh conversation stuck at the top.
  // We force the bottom on the first non-empty render, then re-assert across a
  // few frames to outlast late layout. Retries respect pinnedRef, so a user who
  // scrolls up within the first 500ms isn't yanked back down.
  const didInitialScrollRef = useRef(false);
  // A LAYOUT effect: the first pin writes scrollTop before the browser paints,
  // so even a fast machine never shows one frame of the conversation top. The
  // timed retries below stay post-paint by nature — they outlast late layout.
  useIsoLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (view.length === 0 || anchored.active) return;
    didInitialScrollRef.current = true;
    const el = getViewport();
    if (!el) return;
    const pin = (force: boolean) => {
      if (!pinnedRef.current) return;
      // Cached rows can already be interactive when the server result arrives.
      // Even the nominally "forced" first pin yields to a gesture in flight.
      if (scrollStability.isScrolling() && !scrollStability.isProgrammatic()) return;
      autoScrollRef.current = true;
      scrollStability.scrollTo(scrollStability.maxScrollTop(), 'auto', 'initial-bottom');
      if (force) setPinned(true);
      requestAnimationFrame(() => { autoScrollRef.current = false; });
    };
    pin(true);
    const timers = [60, 200, 500].map((ms) => setTimeout(() => pin(false), ms));
    return () => timers.forEach(clearTimeout);
  }, [view.length, anchored.active, getViewport, scrollStability, setPinned]);

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
  //
  // Read the OPTIMISTIC row too, not just what the server has echoed back. The
  // bubble goes on screen the instant you press send; the header used to wait for
  // that row to come back down the SSE stream before agreeing anything was
  // happening, so the status sat on `ready` while your own message was already
  // visible above it. `pending` is pruned the moment the real row lands, so this
  // only ever covers the gap.
  //
  // The row every status decision below reads: the polled session, with the
  // stream's pushed state folded in when that is the newer of the two.
  //
  // `activity` has to be spliced in explicitly — listSessions deliberately never
  // carries it (chat.ts, the P1-2 payload rule) and `session` prefers the
  // listSessions row, so taking it from `session` silently loses the rich
  // "Bash · 47s" label the moment the list resolves, i.e. always.
  const statusRow = useMemo(
    () => mergeLiveStatus(
      session ? { ...session, activity: sessionOne.data?.activity ?? null } : session,
      pushedStatus,
    ),
    [session, sessionOne.data?.activity, pushedStatus],
  );

  const optimisticUser = pending.length ? pending[pending.length - 1] : null;
  const lastMsg = messages.data?.[messages.data.length - 1];

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
      // First time we observe THIS assistant row — true on mount (which a
      // session switch is: the pane is keyed by sessionId) and when a fresh row
      // actually appears mid turn. Content alone can't tell streaming-just-started from static
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
  //
  // `turnInFlight` is the pure half — see components/chat/composer-core, which
  // is also what the iOS timeline runs. Everything it reads is passed in,
  // including the clock: an optimistic row we just wrote counts as the newest
  // user message, and `turnSettled` needs the gateway to have snapshotted after
  // it (plus DELIVERY_GRACE_MS) before the screen stops looking busy.
  const snapTime = statusRow?.snapshotAt ? new Date(statusRow.snapshotAt).getTime() : 0;
  const { waitingAssistant: isWaitingAssistant, inFlight: isInFlight } = turnInFlight({
    statusState: statusRow?.state ?? null,
    snapshotAt: snapTime,
    lastRole: lastMsg?.role ?? null,
    lastAt: lastMsg ? new Date(lastMsg.createdAt).getTime() : null,
    optimisticAt: optimisticUser ? new Date(optimisticUser.createdAt).getTime() : null,
    streamingTail: !!streamingTailId,
    now: Date.now(),
  });
  // The waiting dispatch queue (undelivered user rows). Refetch only while it
  // matters: the gateway drains as turns end (so poll while in-flight) and the
  // user can cancel (so poll while non-empty); idle + empty → off. Mutations
  // invalidate for instant feedback.
  const queue = trpc.chat.queue.useQuery(
    { sessionId },
    { refetchInterval: (q) => queuePollMs(isInFlight, q.state.data?.length ?? 0) ?? false },
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
  // lands (effect below, keyed on queue.data) or on send error. Deduped by the
  // sent row's id, text only as fallback (see dropLanded), so the hand-off
  // doesn't double-count — including under outgoing auto-translate.
  const [optimisticQueue, setOptimisticQueue] = useState<Array<{ id: string; realId?: string; content: { type: 'text'; text: string }[] }>>([]);
  // Queue rows the user cancelled, hidden before the dequeue round-trip
  // answers. Restored on error or on `removed: false` (the gateway already
  // delivered it — the row belongs back); pruned once the row leaves
  // queue.data for real, so a stale in-flight poll can't flash it back.
  const [removedQueueIds, setRemovedQueueIds] = useState<Set<string>>(() => new Set());
  const displayQueue = queueDisplay(
    queue.data ?? [],
    { starters: starterIds, cancelled: removedQueueIds },
    optimisticQueue,
  );
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
    setOptimisticQueue((q) => {
      const next = dropLanded(q, queue.data ?? []);
      return next.length === q.length ? q : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data]);
  // Drop optimistically-cancelled ids once their row is really gone from
  // queue.data. A row still present keeps its id, so a stale poll answering
  // after the dequeue cannot make the cancelled row flash back.
  useEffect(() => {
    if (removedQueueIds.size === 0) return;
    const live = (queue.data ?? []).map((m) => m.id);
    setRemovedQueueIds((s) => {
      const kept = pruneToLive(s, live);
      return kept.length === s.size ? s : new Set(kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data]);
  // Drop starter ids once their message has been delivered (left queue.data), so
  // the Set stays bounded across a long session. A still-undelivered starter stays
  // hidden; an id no longer in the queue is gone for good.
  useEffect(() => {
    if (starterIds.size === 0) return;
    const live = (queue.data ?? []).map((m) => m.id);
    setStarterIds((s) => {
      const kept = pruneToLive(s, live);
      return kept.length === s.size ? s : new Set(kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data]);
  // Status badge, over `statusRow` (the polled session with the stream's pushed
  // state folded in). unread=false — we're looking at this session, so it's read
  // by definition, and never the red "unread" dot in its own header.
  const statusOpts = {
    // The reach record goes in so a poll of ours that stalled behind a busy
    // dashboard is not read as the gateway having gone quiet. That mattered most
    // here: the fast local signal lapses in the gaps a long tool call leaves, so
    // the header falls back to the snapshot at exactly the moment a finishing
    // tool is stalling the polls that refresh it. See lib/dashboard-reach.
    unread: false, needsYou: !!pendingInteraction, ...dashboardReach(),
  };
  const baseStatus = sessionStatusView(statusRow, { ...statusOpts, liveWorking: isInFlight });
  // When we last read this session as working, and which snapshot we were
  // holding at the time. Written during render on purpose: it is a record of
  // what this very render decided, and an effect would record it one render
  // late — the render in between being exactly the flicker. Re-running the
  // render with the same inputs writes the same values, so a double render
  // (StrictMode, concurrent) changes nothing.
  const workingSeenRef = useRef<{ snapMs: number; atMs: number }>({ snapMs: 0, atMs: 0 });
  if (baseStatus.key === 'working') workingSeenRef.current = { snapMs: snapTime, atMs: Date.now() };
  // A drop to resting is only believed when the snapshot behind it is newer than
  // the one that was on screen while the session was working. Otherwise the fast
  // local signal has merely lapsed — a tool call three seconds into its work,
  // the gap between the send and the first assistant block — and the row under
  // it has not been asked again since. See workingUnconfirmed.
  const holdWorking =
    isRestingState(baseStatus.key)
    && workingUnconfirmed({
      snapshotAt: statusRow?.snapshotAt,
      lastWorkingSnapshotMs: workingSeenRef.current.snapMs,
      lastWorkingAtMs: workingSeenRef.current.atMs,
      now: Date.now(),
    });
  const status = holdWorking
    ? sessionStatusView(statusRow, { ...statusOpts, liveWorking: true })
    : baseStatus;

  // What the live run capsule puts in its header. Read off the raw activity
  // rather than `status.label`, which folds elapsed time into the string — the
  // capsule keeps its own clock and would otherwise print the duration twice.
  // Returned as two PRIMITIVES: the activity object is a fresh identity on every
  // 5s poll, and handing that to memo(MessageTimeline) would re-render the whole
  // visible timeline four times a minute for a label that did not change.
  // From the merged row, not the poll: a pushed status frame carries the current
  // activity, and reading the 5s poll here would leave the capsule naming the
  // PREVIOUS tool for up to five seconds after the header had moved on.
  const rawActivity = statusRow?.activity as Record<string, unknown> | null | undefined;
  const runActivity = useMemo((): { label: string | null; detail: string | null } => {
    const a = rawActivity && typeof rawActivity === 'object' && !Array.isArray(rawActivity) ? rawActivity : null;
    if (!a) return { label: null, detail: null };
    const detail = typeof a.detail === 'string' && a.detail ? a.detail : null;
    const label = typeof a.label === 'string' && a.label ? a.label : null;
    switch (a.kind) {
      case 'tool':
      case 'subagent':
        return { label, detail };
      case 'thinking':
      case 'compacting':
      case 'background':
        return { label: String(a.kind), detail };
      case 'retrying':
        return { label: 'retrying', detail: detail ?? 'the API asked us to back off' };
      default:
        return { label: null, detail: null };
    }
  }, [rawActivity]);

  // Whether the timeline currently ENDS in machinery. When it does, the run
  // capsule at the tail carries the progress bar and the standalone dots below
  // it would be a second indicator for the same fact.
  const tailIsRun = useMemo(() => {
    const last = view[view.length - 1];
    if (!last || !Array.isArray(last.content) || last.content.length === 0) return false;
    // The fold emits a run LAST exactly when the last block is machinery — a
    // turn that narrated and then called a tool ends in a capsule; one that
    // called a tool and then spoke ends in a bubble.
    const blocks = last.content as unknown[];
    return isMachineryBlock(blocks[blocks.length - 1]);
  }, [view]);

  // Expanding a capsule from digested history: fetch the real rows for exactly
  // those message ids, once, and re-fold them into steps. History pages arrive
  // with tool arguments trimmed to a preview and results to their first line
  // (see server/message-digest.ts) — this is the moment the reader asks for the
  // rest, and the only moment it costs anything.
  const resolveRun = useCallback<RunResolver>(
    async (ids) => {
      if (ids.length === 0) return null;
      const rows = await utils.client.chat.getMessages.query({ sessionId, ids });
      return rows.length ? stepsFromRows(rows) : null;
    },
    [utils, sessionId],
  );

  // Tell the sidebar what we can see, so its dot for THIS session is the same
  // dot. Both sides run sessionStatusView over the same listSessions row; what
  // differed was the fast local signal on top of it — the chat page reads the
  // message stream (isInFlight, pendingInteraction), the sidebar only had a
  // send stamp, so a turn we started elsewhere read "working" here and "ready"
  // two inches to the left until the 8s snapshot and the 5s poll caught up.
  // See lib/session-live. 'idle' is published deliberately: it is how a stale
  // send stamp gets overruled.
  const liveStatus: LiveStatus =
    status.key === 'needs-you' ? 'needs-you' : status.key === 'working' ? 'working' : 'idle';
  useEffect(() => {
    if (!sessionId) return;
    const publish = () => publishSessionStatus(sessionId, liveStatus);
    publish();
    // Re-stamp an unchanged value so it can't age past its TTL mid-turn. The
    // write is a no-op for readers (publishSessionStatus only wakes them when
    // the value actually changed), so this costs the sidebar nothing.
    const t = setInterval(publish, STATUS_REFRESH_MS);
    return () => clearInterval(t);
  }, [sessionId, liveStatus]);
  // Stop speaking for a session we've left. The pane is keyed by sessionId, so
  // this cleanup runs on unmount with the OUTGOING id — which is exactly the one
  // that must fall silent.
  useEffect(() => () => clearSessionStatus(sessionId), [sessionId]);

  // The same state, on the Lock Screen and in the Dynamic Island, for whoever is
  // reading this on a phone that is face-down on a table. Reads `status.key` and
  // the elapsed-free activity primitives rather than `status.label`, because the
  // label folds a duration in and the island keeps its own clock — see
  // components/chat/use-live-activity.ts. No-op outside the iOS shell.
  useLiveActivity({
    sessionId,
    agentName: session?.agentName,
    title: session?.title,
    statusKey: status.key,
    activityLabel: runActivity.label,
    activityDetail: runActivity.detail,
    queued: queueLen,
    contextTokens: session?.contextTokens,
    contextWindow: contextWindowFor(session?.runtime, session?.runtimeModel),
  });

  // Which backend runs this session, resolved server-side (a session's own
  // runtime may be null = inherit the agent's). Shown next to ctx because both
  // describe the run rather than the conversation. Both backends are labelled,
  // not just the non-default one: in a mixed fleet "no badge" would be ambiguous
  // between "Claude Code" and "the header hasn't loaded".
  const backendLabel = runtimeShortLabel(session?.runtime);
  const backendTitle = `${runtimeDetail(session?.runtime, session?.runtimeProvider, session?.runtimeModel)} — click for session details`;
  // Whose model answers. Only for a session running on a credential — a
  // built-in backend has none, and there the harness name already says it all.
  const vendorMark = session?.runtimeCredentialId ? providerMark(session.runtimeProvider) : null;

  // What the state chip says when it can no longer say it in full. The chip is
  // the meta row's shrinking item now (see the header), so on a phone
  // "general-purpose +2 bg" arrives as "general-pur…" — and `detail` on its own
  // never carried the label, so the elided half had nowhere left to be read.
  // Label first, detail after it when the activity supplied one.
  const statusTitle = status.detail ? `${status.label} — ${status.detail}` : status.label;

  // The in-dialog "thinking" dots are driven by the SAME status as the header
  // dot, so the two can never disagree. The old code keyed the dots off local
  // SSE signals (isWaitingAssistant / streamingTailId), which settle out of step
  // with the gateway's pane-derived `working` — e.g. a long tool call with no new
  // block for >1.8s cleared the dots while the header still read "working". Show
  // them whenever the session is working OR coming up (starting / restarting).
  const showThinkingDots =
    status.key === 'working' || status.key === 'starting' || status.key === 'restarting';

  // "A turn is running" — for everything that ACTS on that fact: Stop, Escape,
  // and what the composer says about itself — and whether the composer shows its
  // Stop pill. Both decided by `stopPill` in components/chat/composer-core, which
  // carries the reasoning (why the union with status.key, and what it costs) and
  // is the version the iOS timeline runs too. What makes the pill's PLACEMENT
  // safe is in ComposeBar's StopPill. See docs/composer-stop-misfire.md.
  const { turnRunning, show: showStopPill } = stopPill({
    inFlight: isInFlight,
    statusKey: status.key,
    closed: !!session?.closedAt,
  });

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
    if (!turnRunning || session?.closedAt) return;
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
  }, [turnRunning, session?.closedAt, sessionId, cancelTurn]);

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
  // Whatever is already typed goes INTO the template rather than being thrown away:
  // you describe the task in your own words, then pick the shape it runs in.
  const pickPrompt = useCallback((text: string) => {
    composerRef.current?.setText(withDraft(text, taRef.current?.value ?? ''));
  }, []);

  // An element picked in the live-preview panel → APPEND a concise selector,
  // its full DOM path and visible context. Appended, not set: picking one is a
  // step in a sentence you were already typing, not a fresh prompt.
  const pickElement = useCallback((pick: PreviewElementPick) => {
    composerRef.current?.appendText(formatPreviewElementPick(pick));
  }, []);

  // Voice transcript → APPEND to the current draft (never clobber typed text),
  // then focus + caret-to-end + resize (all handled inside ComposeBar).
  // Stable so the memo'd VoiceMic doesn't get fresh props on every SSE tick.
  const startDictation = useCallback((source: DictationSource) => dictationRef.current?.start(source), []);
  const stopDictation = useCallback(() => dictationRef.current?.stop(), []);
  const cancelDictation = useCallback(() => dictationRef.current?.cancel(), []);

  // Stable callbacks for the memo'd ScheduleBar — inline arrows here would give it
  // a fresh prop identity on every SSE tick and defeat the memo. pickPrompt is
  // stable; the *_TEMPLATE strings are module constants.
  const startIterate = useCallback(() => pickPrompt(ITERATE_TEMPLATE), [pickPrompt]);
  const startCron = useCallback(() => pickPrompt(CRON_TEMPLATE), [pickPrompt]);
  const startAutonomy = useCallback(() => pickPrompt(AUTONOMY_TEMPLATE), [pickPrompt]);
  const startPerfect = useCallback(() => pickPrompt(PERFECT_TEMPLATE), [pickPrompt]);

  // "Pure chat" — a header action (see secondaryActions). It opens a NEW
  // read-only session with this agent and navigates there, leaving this
  // conversation exactly as it is.
  //
  // A new session rather than a switch because the read-only tool surface is
  // decided when the child process is spawned (docs/chat-only-mode.md): setting
  // the flag on a live session would change nothing until it respawned.
  //
  // Same createSession mutation as the header's new-chat button, so both share
  // one navigate-on-success.
  //
  // The mutation is destructured first because the dependency linter reads a
  // member expression on a mutable object as "the whole object" — `mutate` and
  // `isPending` as plain consts keep the dep list honest instead of silenced.
  const { mutate: createChat, isPending: creatingChat } = newAgentChat;
  const startPureChat = useCallback(() => {
    const agentName = session?.agentName;
    if (!agentName || creatingChat) return;
    createChat({
      agentName,
      chatOnly: true,
      // Same backend as the conversation you are in — including "no pin at
      // all": a null column means "inherit the agent's default", and omitting
      // the field inherits the same way, so a session that never pinned a
      // backend does not acquire one on the way out.
      ...(session?.runtime ? { runtime: session.runtime } : {}),
      ...(session?.runtimeMode ? { runtimeMode: session.runtimeMode } : {}),
      // No model, deliberately — the same call the new-chat form makes. The
      // model comes from the backend's own default, then its credential's.
    });
  }, [session?.agentName, session?.runtime, session?.runtimeMode, creatingChat, createChat]);

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
  // listSessions row. That 5s poll is machine-wide and was deliberately slimmed
  // (P1-2), so per-session state belongs on the single-row query, which polls at
  // the same 5s anyway.
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
  const hasLivePreview = !!livePreview && !session?.closedAt;
  const previewOpen = hasLivePreview && !!previewOpenUrl && previewOpenUrl === livePreview?.url;
  // Shown only once it is mounted AND the browser has painted it closed — a
  // transition needs a frame at the starting value or there is nothing to
  // animate from, and the panel would simply appear at full width.
  const previewSlidIn = previewOpen && previewShown;
  // Cmd/Ctrl+\ toggles the live-preview split — VS Code's split-editor key,
  // free in every browser. Same shape as the ⌘/ and ⌘F handlers above; a
  // no-op unless the session has a registered preview (the FAB's condition).
  const livePreviewUrl = hasLivePreview ? (livePreview?.url ?? null) : null;

  // Mount the panel WITHOUT showing it. Only the edge swipe needs this: a drag
  // has to have something on screen to drag, and this panel does not exist until
  // someone asks for it. A tap goes straight through openPreview below.
  const primePreview = useCallback((url: string) => {
    if (previewExit.current) { clearTimeout(previewExit.current); previewExit.current = null; }
    setPreviewOpenUrl(url);
  }, []);

  const openPreview = useCallback((url: string) => {
    primePreview(url);
    // No frame-juggling here: the panel times its own enter (it is lazy-loaded,
    // so this side cannot know when it exists). This flag only says "should be
    // showing" — it keeps the panel mounted and tucks the tab away.
    setPreviewShown(true);
  }, [primePreview]);

  const closePreview = useCallback(() => {
    setPreviewShown(false);
    if (previewExit.current) clearTimeout(previewExit.current);
    previewExit.current = setTimeout(() => { setPreviewOpenUrl(null); previewExit.current = null; }, PREVIEW_SLIDE_MS);
  }, []);

  useEffect(() => () => { if (previewExit.current) clearTimeout(previewExit.current); }, []);

  // The other way in, on a phone: drag the panel out of the right edge instead of
  // tapping the tab welded to it. The gesture needs the panel's node, because it
  // moves the layer with the finger rather than through React.
  const previewPanelRef = useRef<HTMLDivElement | null>(null);
  const settlePreview = useCallback(
    (open: boolean) => {
      if (open && livePreviewUrl) openPreview(livePreviewUrl);
      else closePreview();
    },
    [livePreviewUrl, openPreview, closePreview],
  );
  usePreviewSwipe({
    url: livePreviewUrl,
    open: previewSlidIn,
    panelRef: previewPanelRef,
    onPrime: primePreview,
    onSettle: settlePreview,
  });

  useEffect(() => {
    if (!livePreviewUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '\\' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (previewOpenUrl === livePreviewUrl) closePreview();
      else openPreview(livePreviewUrl);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [livePreviewUrl, previewOpenUrl, openPreview, closePreview]);

  const secondaryActions = (
    <>
      {/* Pure chat. In THIS group, not beside the new-chat button, because this
          group is the one that folds — inline while the chat column is ≥40rem,
          in the ⋯ tray below that — and because it is folded a second time by
          being a ConfirmIconButton: the icon alone until you touch it, and only
          then the words. Both foldings are the same judgement, that a control
          you reach for occasionally should not spend the day taking up width.

          Nothing here can switch a LIVE session to read-only — the tool surface
          is chosen when the child is spawned — so it opens a new one instead,
          which is also why it is not a toggle. */}
      <ConfirmIconButton
        icon={Eye}
        confirmLabel="pure chat"
        title="pure chat — start a NEW read-only session with this agent. It can look at files, search the web and add to its own memory, but cannot write, edit, run commands or spawn sub-agents. This conversation is untouched."
        busy={creatingChat}
        disabled={!session?.agentName}
        onConfirm={startPureChat}
      />
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

  // Start another chat with the same agent. NOT one of the secondary actions
  // above: on a phone those fold into the "more" tray, and this is the one
  // among them you reach for without already being in the middle of something
  // — a thought that has nothing to do with the conversation on screen. Two
  // taps to open a tray was enough friction that the sidebar's New chat, which
  // costs opening the drawer and picking the agent again, was winning. Rendered
  // once, in the persistent cluster, so it is the same button at every width.
  // Placed immediately RIGHT of the tray toggle (sway's call) — the toggle is
  // hidden above 40rem, so on a wide header it lands after the inline group
  // instead, and the row reads actions-then-exits either way.
  const newChatButton = (
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
                  <span className="truncate">{chatHeaderTitle(session, sessionId)}</span>
                  <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover/title:opacity-100 transition-opacity text-muted-foreground/70" aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground truncate">
              {/* Agent name leads the status line on every width — on a phone the
                  sidebar is collapsed away, so this was the only thing telling you
                  WHICH agent you're talking to. Capped and truncating: it shares the
                  row's shrinking with the state chip below, and everything after the
                  two of them is shrink-0, so those two are what yield instead of the
                  backend or the context bar being pushed off the edge. */}
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
                  {/* The live state, back under the title where sway wants it: this
                      row is the run metadata, and the state is run metadata. Dot
                      first, so it leads the item it describes instead of trailing
                      it as decoration — the same reading order as the sidebar row.

                      It SHRINKS (min-w-0, not shrink-0). It is the one item here
                      that grows without bound — a claude-sdk session says "Bash ·
                      47s", "retrying 2/5, 12s", "general-purpose +2 bg" — and
                      everything to its right is shrink-0, so holding its full
                      width simply ran the row off the edge. Not harmlessly: this
                      row's `truncate` is on a FLEX container, where text-overflow
                      does nothing, so the overflow was amputated without an
                      ellipsis and the ctx bar was the first thing to go.

                      Flex distributes the shortfall in proportion to width, so
                      the longest item concedes the most: a long state yields to a
                      short agent name, which is the order you want — the name is
                      four letters of identity, the state is a sentence. The full
                      text is in the tooltip, which now carries the LABEL and not
                      just the detail, since the label is the half that gets cut. */}
                  {/* Tappable, like the backend chip two items along: this is
                      the state, and the sheet is where the state is spelled out
                      — which background tasks are running and for how long, the
                      one thing the chip has no room to say. A phone has no
                      hover, so the tooltip that carried the detail reached a
                      laptop only. */}
                  <button
                    type="button"
                    onClick={() => setDetailOpen(true)}
                    title={statusTitle}
                    aria-label="session state — open details"
                    className="min-w-0 inline-flex items-center gap-1.5 rounded px-1 -mx-1 cursor-pointer transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    <span
                      className={cn('h-1.5 w-1.5 shrink-0 rounded-full transition-colors', status.dot, status.pulse && 'animate-pulse')}
                      aria-hidden="true"
                    />
                    <span className="max-w-[11rem] truncate">{status.label}</span>
                  </button>
                  <span className="shrink-0 text-muted-foreground/40">·</span>
                  {/* Which backend is actually running this session. Sits left of
                      ctx because both describe the run, not the conversation.
                      Short labels — the meta line is already tight at 390px.
                      Also the way IN to the session detail: the backend is the
                      thing you'd click this line to change.

                      Two facts share this chip when the session runs on a
                      credential: which harness, and whose model answers. The
                      second is the one that was missing — a claude-sdk session
                      pointed at Kimi read plain "Claude", exactly like one on
                      this machine's Anthropic subscription, so nothing on
                      screen said which account the turn was billed to.

                      Both only fit above 40rem. Below it the VENDOR wins and
                      the harness falls back to the tooltip: it is the half you
                      cannot deduce (you chose the backend; you cannot see the
                      endpoint), and spending the row's last 30px on it is what
                      kept the agent name from truncating to "a…" — measured at
                      390px, the width where this row has nothing to spare. Same
                      trade the ctx bar makes two items along. */}
                  <button
                    type="button"
                    onClick={() => setDetailOpen(true)}
                    title={backendTitle}
                    aria-label="session details"
                    className="shrink-0 font-mono rounded px-1 -mx-1 cursor-pointer transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    {vendorMark ? (
                      <>
                        <span className="hidden @min-[40rem]:inline">
                          {backendLabel}<span className="text-muted-foreground/40">·</span>
                        </span>
                        <span className="text-foreground">{vendorMark}</span>
                      </>
                    ) : backendLabel}
                  </button>
                  {/* Model, next to the backend that runs it — the two answer
                      one question together. Claude Code and codex: those are the
                      two backends that own their model catalogue AND apply a
                      switch without losing the conversation. The pane driver and
                      the credential-backed harnesses take their model from
                      elsewhere, and a picker that silently did nothing would be
                      worse than no picker at all.

                      Not on a share link: the catalogue behind the menu is a
                      machine-wide endpoint, which a scoped key is refused (same
                      reason the terminal link below is hidden), so the menu
                      would open empty.

                      Nor on a claude-sdk session that runs on a CREDENTIAL. The
                      list is this machine's own `supportedModels()` — Opus,
                      Sonnet, Haiku — and none of those names exists at a Kimi
                      or GLM endpoint, so the menu would offer five rows that
                      all fail. That backend's model is its own, set once in
                      Settings → Backends, exactly like pi's and prime's. codex
                      needs no such exclusion: it authenticates as itself, with
                      one catalogue per machine. */}
                  {!scope.scoped
                    && (session.runtime === 'codex-exec'
                      || (session.runtime === 'claude-sdk' && !session.runtimeCredentialId)) && (
                    <>
                      <span className="shrink-0 text-muted-foreground/40">·</span>
                      <ModelChip
                        sessionId={sessionId}
                        runtime={session.runtime}
                        model={session.runtimeModel}
                        disabled={!!session.closedAt}
                      />
                    </>
                  )}
                  <span className="shrink-0 text-muted-foreground/40">·</span>
                  {/* Full bar (count + 56px track + percent) is ~130px and crowded a
                      390px header; mobile gets `mini` — same token count, shorter
                      track, no percent.

                      No "ctx" label on either (showLabel={false}): the coloured
                      track already reads as a meter, the tooltip spells out
                      "context N / M tokens", and the three letters cost width on
                      the row that has least of it. The label stays on by default
                      for the detail sheets, where the bar sits among unrelated
                      rows and has to name itself. */}
                  <span className="sm:hidden shrink-0">
                    <CtxBar
                      tokens={session.contextTokens}
                      total={contextWindowFor(session.runtime, session.runtimeModel)}
                      variant="mini"
                      showLabel={false}
                    />
                  </span>
                  <span className="hidden sm:inline-flex shrink-0">
                    <CtxBar
                      tokens={session.contextTokens}
                      total={contextWindowFor(session.runtime, session.runtimeModel)}
                      showLabel={false}
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
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 transition-colors cursor-pointer animate-in fade-in-0 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-wait"
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
              // Never wider than the room to its left. `100%` in this calc is the
              // anchor's own width (the persistent cluster), so this is exactly
              // "viewport minus the buttons I am floating left of". Without it the
              // tray grew past the screen edge whenever the cluster gained a
              // button (archived → Restore, a tmux session → terminal) or a
              // confirm armed inside it (28px icon → 121px pill), and the cancel
              // ✕ ended up off-screen behind an overflow-hidden ancestor.
              'max-w-[calc(100vw-100%-1.5rem)] overflow-x-auto overscroll-x-contain',
              '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
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
          {newChatButton}
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

      {/* Height-animated (Collapse) so opening ⌘F slides the timeline down
          instead of amputating 44px from it in one frame. */}
      <Collapse open={findOpen}>
        <ChatFind
          sessionId={sessionId}
          getViewport={getViewport}
          scrollStability={scrollStability}
          onJump={anchored.jumpTo}
          onClose={() => setFindOpen(false)}
        />
      </Collapse>

      {/* Mounted only once opened, so an untouched chat never pays for the
          detail query; kept mounted afterwards so the sheet animates out. */}
      {(detailOpen || detailEverOpened.current) && (
        <Suspense fallback={null}>
          <SessionDetailSheet sessionId={sessionId} open={detailOpen} onOpenChange={setDetailOpen} />
        </Suspense>
      )}

      {/* Anchored mode banner: you're parked on a search hit, not at the live
          tail. Without this the frozen timeline reads as a stuck session. */}
      <Collapse open={anchored.active}>
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
      </Collapse>

      <ScrollArea ref={scrollRef} className="flex-1 min-h-0 bg-background">
        {/* overflow-x-clip guarantees the conversation never scrolls sideways as
            a whole; wide content (tables, code) scrolls within its own message.
            `clip` (not hidden) avoids forcing overflow-y to auto. */}
        <div data-scroll-stability-layer className="px-4 py-4 max-w-3xl mx-auto overflow-x-clip [overflow-anchor:none]">
          {loadingTimeline ? (
            // Blank for the first ~100ms (see showSkeleton above) — an IDB/cache
            // hit lands inside that window and paints content with no skeleton
            // flash at all; only a genuinely slow load ever shows one.
            showSkeleton ? <Skeleton className="h-32" /> : null
          ) : view.length === 0 && messages.isError ? (
            // Load FAILED — before this branch the same situation rendered
            // EmptyChat, which tells the user a conversation full of history
            // simply doesn't exist. Say it failed and offer a retry.
            <div className="animate-in fade-in-0 duration-150 flex flex-col items-center gap-3 py-20 text-center">
              <p className="text-sm text-muted-foreground">Couldn&apos;t load this conversation.</p>
              <button
                type="button"
                onClick={() => { void messages.refetch(); }}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors cursor-pointer hover:border-foreground/30 hover:text-foreground hover:bg-accent/40"
              >
                Retry
              </button>
            </div>
          ) : view.length === 0 ? (
            <div className="animate-in fade-in-0 duration-150">
              <EmptyChat agentName={session?.agentName} onPickPrompt={pickPrompt} />
            </div>
          ) : (
            <div className="animate-in fade-in-0 duration-150">
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
              <RunDetailContext.Provider value={resolveRun}>
                <MessageTimeline
                  messages={view}
                  streamingTailId={streamingTailId}
                  streamKey={sessionId}
                  sessionId={sessionId}
                  dotClass={status.dot}
                  getViewport={getViewport}
                  scrollStability={scrollStability}
                  settlePrepend={prependAnchor.reassert}
                  running={turnRunning}
                  runLabel={runActivity.label}
                  runDetail={runActivity.detail}
                />
              </RunDetailContext.Provider>
            </div>
          )}
          {/* Only show the standalone dots-below indicator while the assistant
              has not yet emitted any content. Once the bubble appears, dots
              live inline at the bubble's tail (StreamingDots) — and when the
              turn is off in a tool chain, the run capsule's own sweep bar is
              the indicator, so a second breathing dot below it is just noise. */}
          {showThinkingDots && !streamingTailId && !tailIsRun && (
            <div className="animate-in fade-in-0 duration-150">
              <TypingIndicator dot={status.dot} />
            </div>
          )}
        </div>
      </ScrollArea>
      {/* Scroll-to-latest, in a zero-height strip above the ComposeBar. Stop used
          to share this strip; it is back inside the composer row now (right of
          the text, left of send — see StopPill there). Pointer-events gated so
          the strip never catches clicks meant for the conversation behind it. */}
      <div className="relative mx-auto h-0 w-full max-w-3xl px-3 z-10 pointer-events-none">
        <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            aria-label="scroll to latest"
            aria-hidden={pinnedToBottom || (messages.data?.length ?? 0) === 0}
            tabIndex={pinnedToBottom || (messages.data?.length ?? 0) === 0 ? -1 : undefined}
            className={cn(
              // Centred, and no longer stacked above: Stop lives inside the
              // composer row now, so the two can't collide.
              'absolute left-1/2 -translate-x-1/2 bottom-3',
              'inline-flex items-center gap-1 rounded-full border border-border bg-background/95',
              'px-3 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur',
              'hover:bg-accent hover:text-foreground cursor-pointer',
              // Always mounted; the tray-pattern fade keeps it from popping.
              'transition-[opacity,transform,background-color,color] duration-200',
              !pinnedToBottom && (messages.data?.length ?? 0) > 0
                ? 'pointer-events-auto opacity-100 translate-y-0'
                : 'pointer-events-none opacity-0 translate-y-2',
            )}
          >
            <span aria-hidden="true">↓</span> latest
          </button>
      </div>

        {/* Nothing floats over the chat any more. Voice moved into the composer
            (hold the box to talk, or tap the mic beside it), takeover into the
            suggestion row, and the preview is a tab welded to the right edge —
            the edge its panel comes out of. */}
        {hasLivePreview && livePreviewUrl && (
          <Suspense fallback={null}>
            <PreviewTab open={previewSlidIn} onOpen={() => openPreview(livePreviewUrl)} />
          </Suspense>
        )}
        {/* Plain wrapper — it used to be measured to keep the mic above this stack.
            The mic goes wherever it's dragged now; the div stays because it's one
            flex item, and unwrapping it would respace the whole control column. */}
        <div>
          <MicHintBar hint={micHint} />
          {/* One quiet line: what is still running after the reply. Above the
              suggestion chips, not in a box — sway wants it small. */}
          <BackgroundBar activity={rawActivity} />
          <ScheduleBar
            chatOnly={!!session?.chatOnly}
            onStartIterate={startIterate}
            onStartCron={startCron}
            onStartAutonomy={startAutonomy}
            onStartPerfect={startPerfect}
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
          <Collapse open={takenOver && !!takeover}>
            {takeover && (
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
          </Collapse>
          <QueueBar
            items={displayQueue}
            onCancel={(id) => {
              // A still-optimistic stub isn't a real DB row yet — drop it locally;
              // a real queued row goes through the dequeue mutation. Decided by
              // membership rather than by the id's shape, so the same rule ports.
              if (queueCancelTarget(id, optimisticQueue.map((x) => x.id)) === 'local') {
                setOptimisticQueue((q) => q.filter((x) => x.id !== id));
                return;
              }
              // Optimistic: hide the row NOW instead of after the round-trip +
              // invalidate. Put it back if the call fails or the server answers
              // removed:false — that means the gateway already delivered it, so
              // the row belongs in the timeline, not in the bin.
              const restore = () =>
                setRemovedQueueIds((s) => { const n = new Set(s); n.delete(id); return n; });
              setRemovedQueueIds((s) => new Set(s).add(id));
              dequeue.mutate(
                { messageId: id },
                {
                  onSuccess: (r) => { if (!r.removed) restore(); },
                  onError: restore,
                },
              );
            }}
            onClear={() => { setOptimisticQueue([]); clearQueue.mutate({ sessionId }); }}
            clearing={clearQueue.isPending}
          />
          <Suspense fallback={null}>
            <DictationDock
              ref={dictationRef}
              sessionId={sessionId}
              composerRef={composerRef}
              onNotice={setComposerNotice}
            />
          </Suspense>
          <ComposeBar
            sessionId={sessionId}
            disabled={!!session?.closedAt}
            awaitingInput={!!pendingInteraction}
            sending={send.isPending}
            inFlight={turnRunning}
            queueFull={queueIsFull(queueLen)}
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
              // Outgoing auto-translate. The optimistic bubble above already
              // shows what was TYPED, so the send stays instant to the eye and
              // the ~0.4s translation happens behind it; the real row lands in
              // English and translate-outbound puts the Chinese back at render
              // time. On any failure translateOutgoing returns the input, so
              // the worst case is the message going out exactly as typed.
              const prefs = readTranslatePrefs();
              sendChainRef.current = sendChainRef.current.then(async () => {
                const sendText =
                  text && prefs.on && prefs.autoOut ? await translateOutgoing(sessionId, text) : text;
                send.mutate(
                  { sessionId, text: sendText, images, files },
                  {
                    onSuccess: (msg) => {
                      if (wasIdle) setStarterIds((s) => { const n = new Set(s); n.add(msg.id); return n; });
                      // Hand the optimistic rows over to their real counterpart
                      // BY ID: they stay on screen until that exact row lands in
                      // server data (see dropLanded), so a translated send — real
                      // row English, optimistic row Chinese — still reconciles.
                      setPending((p) => p.map((x) => (x.id === optimisticId ? { ...x, realId: msg.id } : x)));
                      setOptimisticQueue((q) => q.map((x) => (x.id === optimisticId ? { ...x, realId: msg.id } : x)));
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
                // A rejection anywhere in the chain would silently kill every
                // send after it. Nothing above is supposed to throw — swallow
                // it here so that stays true even if something starts to.
              }).catch(() => {});
            }}
            ref={composerRef}
            attachments={attachments}
            setAttachments={setAttachments}
            notice={composerNotice}
            setNotice={setComposerNotice}
            onStop={showStopPill ? () => cancelTurn.mutate({ sessionId }) : undefined}
            stopping={cancelTurn.isPending}
            taRef={taRef}
            history={sentHistory}
            onDictate={session?.closedAt ? undefined : startDictation}
            onDictateStop={stopDictation}
            onDictateCancel={cancelDictation}
            onMicHint={setMicHint}
          />
        </div>
      </div>
      {previewOpen && livePreview && (
        // key: a re-registration rotates the URL, and the panel's history
        // bookkeeping is only true of the frame it was counted in.
        <Suspense fallback={null}>
          <LivePreviewPanel
            key={livePreview.url}
            preview={livePreview}
            open={previewSlidIn}
            onClose={closePreview}
            onPickElement={pickElement}
            rootRef={previewPanelRef}
          />
        </Suspense>
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
// The two starters the suggestion chips drop into the composer. Both create the
// SAME thing — a hermit cron via mcp__hermit__cron_create, durable, listed on
// /cron, reporting each run into this chat — because a 定时任务 and a 循环 stopped
// being different objects when the session-scoped loop was retired
// (docs/cron-merge-design.md). What differs is the SHAPE of the task:
//
//   ITERATE_TEMPLATE — the runs build on each other and there is a finish line, so
//     the task carries its progress in a file and ends itself when it gets there.
//     That finish line is "全部做完", not a blank to fill in: nobody can state a
//     stop condition before starting, so the old <完成条件> slot went out unedited.
//   CRON_TEMPLATE — a periodic check whose runs are independent and which nobody
//     expects to finish.
//
// Prompt templates stay in Chinese on purpose: they are typed at the AGENT, and the
// English rule covers the product's own UI, not what you say to an agent.
//
// None of them tells the agent to test itself. "做完自己测一遍" read as an order to
// write unit tests, so runs came back with a passing count instead of the thing
// working; the check that matters is the report you read, and for the perfect
// chip, the fresh reviewer.

// The blank each template leaves for the task itself. A chip fills it with the
// current draft (pickPrompt); with nothing typed the blank stays, as a prompt to
// write one. Before this, a chip overwrote the draft — so the one order that makes
// sense, type then choose, silently threw the typing away.
const TEMPLATE_SLOT = /<要做的事>|<目标>/;

function withDraft(template: string, draft: string): string {
  const task = draft.trim();
  if (!task) return template;
  // Function replacement, not a string: a draft containing $& or $1 would
  // otherwise be spliced by replace()'s own substitution rules. The trailing
  // full stop goes because the template supplies its own right after the slot.
  if (TEMPLATE_SLOT.test(template)) {
    const clause = task.replace(/[。.]+$/, '');
    return template.replace(TEMPLATE_SLOT, () => clause);
  }
  // Slotless (the autonomy nudge, the empty-state starters) — the directive
  // follows the task instead of replacing it.
  return `${task}\n\n${template}`;
}

const ITERATE_TEMPLATE =
  '开启循环任务：每 1 小时，<要做的事>。每轮先读上一轮留下的进展文件再接着做，把结果发到这个对话；全部做完后自动停止。';

const CRON_TEMPLATE =
  '开启定时任务：每 60 分钟（时间上下浮动 ±10 分钟），<要做的事>。每次独立后台运行（不占用本对话上下文），跑完把结果发回这个对话，完整历史在 /cron 页面。';

// One-shot autonomy nudge (NOT a recurring task): tells the agent to proceed with
// its own recommendation and stop asking for confirmation until the work is done.
// Dropped by the "Run to done" suggestion — no cadence, so it doesn't trip the
// cron skill; it's a plain directive for the current task.
const AUTONOMY_TEMPLATE = '按照你的推荐做，不再询问我，直到做完。';

// The "Perfect it" suggestion — the strict sibling of AUTONOMY_TEMPLATE. Both say
// "carry on without me"; the difference is where they stop. Run-to-done stops when
// the agent believes it is finished; this one stops when a fresh critic finds no
// real problem left, inside a 24-hour budget (the perfect-goal skill). The wording
// names the mechanism (清单 / 评审 / 截图 / 24 小时) so the skill fires on it
// rather than being read as ordinary emphasis.
const PERFECT_TEMPLATE =
  '把这件事做到完美：<目标>。先写一份每条都能验证的验收清单（越短越好），然后一轮轮做，有界面就截个图，再交给一个全新的评审 agent 看有没有真问题，把问题改掉；评审挑不出真问题就算完。全程不超过 24 小时：一开始就把范围裁到 24 小时内能交付，快到时直接收尾汇报。';
