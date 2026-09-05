'use client';

// The one session row in the sidebar — lifted out of recent-lists.tsx unchanged so
// it can be RENDERED BY ITSELF, with no tRPC client, no router and no browser.
//
// That is the whole reason this file exists. `tools/pixel-compare.sh` puts the web
// row and the native SwiftUI row side by side on the same fixture, and a comparison
// is only worth anything if the thing it screenshots is the row this app actually
// ships. Importing recent-lists.tsx to get at it would drag in the trpc client, the
// Next router hooks and base-ui, none of which survive react-dom/server; copying the
// markup into the harness would compare the port against a second port. So the row
// lives here, alone, fed only props — the same discipline SessionRowView.swift is
// held to on the other side (pure SwiftUI over a plain value, so render-list.sh can
// draw it on a Mac).
//
// Keep it that way: every import below must be renderable on a bare Node process.
// The row is memo()'d and given only stable props by its callers, so unchanged rows
// bail out of the sidebar's 5s poll instead of re-running sessionStatusView/relTime
// for all ~60 of them.

import { memo } from 'react';
import Link from 'next/link';
import { Pin, EyeOff, Moon } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { sessionRecencyAt } from '@/lib/session-recency';
import { isRestingState, sessionStatusView } from '@/lib/session-status';
import { dashboardReach } from '@/lib/dashboard-reach';
import { isSessionUnread } from '@/lib/session-read';
import type { LiveStatus } from '@/lib/session-live';
import type { useLongPress } from '@/lib/use-long-press';

type SessionListItem = inferRouterOutputs<AppRouter>['chat']['listSessions'][number];

// One session row. memo'd: `session` is stable across a no-op poll (RQ structural
// sharing), `active`/`liveAt`/`live`/`pinned` are primitives, and onPrefetch/
// onOpenMenu/longPress are stable, so an unchanged row bails. The optimistic-working
// / unread / status derivation runs INSIDE the row (only when it re-renders), and the
// per-row handlers are built here from the stable callbacks — neither defeats the memo.
export const SessionRow = memo(function SessionRow({
  session: s,
  active,
  liveAt,
  live,
  pinned,
  onPrefetch,
  onSelect,
  onOpenMenu,
  longPress,
}: {
  session: SessionListItem;
  active: boolean;
  liveAt: number | null;
  live: LiveStatus | null;
  pinned: boolean;
  onPrefetch: (id: string) => void;
  onSelect: (id: string) => void;
  onOpenMenu: (id: string, x: number, y: number) => void;
  longPress: ReturnType<typeof useLongPress>;
}) {
  // Optimistic working: the moment the user sends, the session is marked live
  // (markSessionWorking) so this dot turns yellow instantly — no waiting ~13s for
  // the gateway snapshot + 5s poll. Reconcile with the gateway's truth: once it
  // snapshots the pane AFTER the send (snapshotAt > stamp), drop the optimism and
  // let the real `state` drive the dot.
  const optimisticWorking = liveAt != null && (!s.snapshotAt || new Date(s.snapshotAt).getTime() < liveAt);
  // …but a chat page open on this session doesn't have to guess: it reads the
  // message stream and the pending-interaction blocks, so when it is speaking
  // (`live` non-null) its reading REPLACES the guess in both directions — it can
  // say "working" ~13s before any snapshot could, and its 'idle' retires a send
  // stamp whose turn quietly died. Same function, same row, same inputs as the
  // header two inches to the right; that is the point. See lib/session-live.
  // Read inside the row, not passed in: contact with the dashboard is a fact
  // about the tab, and a prop that changed on every 5s poll would re-render
  // every row in the sidebar — the exact cost this memo exists to avoid. A
  // synchronous read costs nothing extra in a render that already calls
  // Date.now(), and the row's status only has to be right when it renders.
  const status = sessionStatusView(s, {
    unread: isSessionUnread(s),
    liveWorking: live !== null ? live === 'working' : optimisticWorking,
    needsYou: live === 'needs-you',
    ...dashboardReach(),
  });
  return (
    <li>
      <Link
        href={`/chat?session=${encodeURIComponent(s.id)}`}
        // Active styling on the click, not on the URL commit (long-press
        // swallows this click after its menu fires, so no false active).
        onClick={() => onSelect(s.id)}
        onMouseEnter={() => onPrefetch(s.id)}
        onFocus={() => onPrefetch(s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu(s.id, e.clientX, e.clientY);
        }}
        {...longPress(s.id)}
        className={cn(
          'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors select-none [-webkit-touch-callout:none]',
          active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
          s.closedAt && 'opacity-60',
          s.hiddenAt && 'opacity-50',
          s.hibernatedAt && !s.closedAt && 'opacity-60',
        )}
        // The status is on the row whether or not it is printed: a resting
        // state shows only a dot, and this is where you find out which one.
        title={`${s.title || s.preview || s.agentName}\n${status.detail ?? status.label}`}
      >
        <div className="flex items-start gap-2 min-w-0">
          <span
            className={cn('mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 transition-colors', status.dot, status.pulse && 'animate-pulse')}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-1.5">
              <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                {s.title || s.preview || s.agentName}
              </span>
              {pinned && (
                <Pin className="h-3 w-3 shrink-0 self-center -rotate-45 fill-current text-muted-foreground/70" aria-label="pinned" />
              )}
              {s.hiddenAt && (
                <EyeOff className="h-3 w-3 shrink-0 self-center text-muted-foreground/60" aria-label="hidden" />
              )}
              {s.hibernatedAt && (
                <Moon className="h-3 w-3 shrink-0 self-center text-muted-foreground/60" aria-label="asleep — wakes on send" />
              )}
              <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                {relTime(sessionRecencyAt(s))}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/75 tabular-nums truncate">
              <span className="truncate">{s.agentName}</span>
              {/* A label for everything EXCEPT the resting states. 'asleep' joins
                  'ready' there on purpose: with claude-sdk most of this list has
                  no live child at any moment, so labelling it would print the
                  same word down the whole sidebar. The dimmed dot carries it,
                  and the row's title spells it out. */}
              {!isRestingState(status.key) && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{status.label}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
});
