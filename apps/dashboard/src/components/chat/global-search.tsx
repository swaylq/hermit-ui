'use client';

// Global message search — every session in the active workspace, served from the
// browser's own cache. What makes this possible is that only PROSE is cached
// (~11 MB for the production machine vs ~900 MB of raw content); see
// server/chat-text.ts.
//
// Opened by the sidebar's magnifier or ⌘K. Results are newest-first across all
// sessions; picking one opens that session positioned on that message, which is
// what chat.listMessagesAround exists for — the timeline otherwise only ever
// walks back from the newest row.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, CornerDownLeft } from 'lucide-react';
import { Overlay } from '@/components/overlay';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { onOpenGlobalSearch } from '@/lib/chat-cache/search-bus';
import { useChatSearch, useCachedSessionMeta, useChatCacheSyncStatus, coverageLabel } from '@/lib/chat-cache/use-chat-cache';
import type { SearchHit } from '@/lib/chat-cache/types';

// Render a snippet with its match ranges highlighted. Ranges are already in
// snippet coordinates and sorted (search-core walks matches left to right), so a
// single pass suffices.
function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  if (ranges.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([s, e], i) => {
    if (s < cursor) return; // defensive: overlapping ranges can't happen, but don't scramble text if they did
    if (s > cursor) out.push(text.slice(cursor, s));
    out.push(
      <mark key={i} className="rounded-sm bg-amber-300/70 text-foreground dark:bg-amber-500/40">
        {text.slice(s, e)}
      </mark>
    );
    cursor = e;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

function HitRow({
  hit,
  label,
  agentName,
  active,
  onPick,
}: {
  hit: SearchHit;
  label: string;
  agentName: string | null;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <Link
      href={`/chat?session=${encodeURIComponent(hit.sessionId)}&msg=${encodeURIComponent(hit.id)}`}
      onClick={onPick}
      data-active={active || undefined}
      className={cn(
        'block px-3 py-2 rounded-md transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60'
      )}
    >
      <div className="flex items-center gap-2 min-w-0 text-xs text-muted-foreground">
        {agentName && (
          <span className="shrink-0 px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{agentName}</span>
        )}
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums">{relTime(hit.createdAt)}</span>
      </div>
      <div className="mt-1 text-sm leading-snug break-words line-clamp-3">
        <span className="text-muted-foreground/70">{hit.truncatedLeft ? '…' : ''}</span>
        <Highlighted text={hit.snippet} ranges={hit.ranges} />
        <span className="text-muted-foreground/70">{hit.truncatedRight ? '…' : ''}</span>
      </div>
    </Link>
  );
}

function SearchPanel({ close }: { close: () => void }) {
  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const meta = useCachedSessionMeta();
  const status = useChatCacheSyncStatus();
  const coverage = coverageLabel(status);

  // The filter is resolved to a session allow-list here, where the session meta
  // (agent name) is already in hand. search-core only knows message rows, which
  // carry no agent, so the agent → sessions join must happen before the search.
  const agentNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of meta.values()) if (s.agentName) names.add(s.agentName);
    return Array.from(names).sort();
  }, [meta]);

  const sessionIds = useMemo(() => {
    if (!agentFilter) return undefined;
    const ids: string[] = [];
    for (const s of meta.values()) if (s.agentName === agentFilter) ids.push(s.sessionId);
    return ids.sort();
  }, [meta, agentFilter]);

  const { result, searching } = useChatSearch(query, sessionIds ? { sessionIds } : {});

  useEffect(() => inputRef.current?.focus(), []);

  // A fresh result set puts the keyboard cursor back on the first hit. Adjusted
  // during render (not in an effect) so the highlighted row and the results it
  // belongs to always paint in the same frame.
  const [cursorFor, setCursorFor] = useState<typeof result>(null);
  if (cursorFor !== result) {
    setCursorFor(result);
    setCursor(0);
  }

  const hits = useMemo(() => result?.hits ?? [], [result]);

  // Keep the keyboard cursor in view as it moves past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(hits.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      const target = hits[cursor];
      if (!target) return;
      e.preventDefault();
      close();
      window.location.assign(`/chat?session=${encodeURIComponent(target.sessionId)}&msg=${encodeURIComponent(target.id)}`);
    }
  };

  return (
    <div
      className="w-[min(46rem,calc(100vw-2rem))] max-h-[min(38rem,calc(100vh-6rem))] flex flex-col rounded-xl border border-border bg-background shadow-2xl overflow-hidden"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 h-12 border-b border-border shrink-0">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={agentFilter ? `搜索 ${agentFilter}…` : '搜索全部会话…'}
          aria-label="search all conversations"
          className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-muted-foreground/60"
        />
        {agentNames.length > 1 && (
          <div onKeyDown={(e) => e.stopPropagation()}>
            <Select value={agentFilter} onValueChange={(v) => setAgentFilter(v ?? '')} modal={false}>
              <SelectTrigger
                aria-label="按 agent 筛选搜索结果"
                className="w-auto shrink-0 h-7 px-2 text-xs font-mono text-muted-foreground"
              >
                <SelectValue>{(v: string | null) => (v ? v : '全部')}</SelectValue>
              </SelectTrigger>
              <SelectContent className="font-mono">
                <SelectItem value="">全部</SelectItem>
                {agentNames.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {result && (
          <span className="shrink-0 text-xs font-mono tabular-nums text-muted-foreground">
            {result.totalMessages} 条
          </span>
        )}
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {!query.trim() ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            {agentFilter
              ? `搜索 ${agentFilter} 的 ${sessionIds?.length ?? 0} 个会话。结果按时间倒序，↑↓ 选择，回车打开。`
              : `搜索这台机器上全部 ${status.totalSessions || '—'} 个会话的对话正文。结果按时间倒序，↑↓ 选择，回车打开。`}
          </p>
        ) : searching && !result ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">搜索中…</p>
        ) : hits.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">没有匹配。</p>
        ) : (
          hits.map((h, i) => {
            const m = meta.get(h.sessionId);
            return (
              <HitRow
                key={h.id}
                hit={h}
                agentName={m?.agentName ?? null}
                label={m?.title || m?.preview || '未命名会话'}
                active={i === cursor}
                onPick={close}
              />
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 h-9 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="h-3 w-3" /> 打开
        </span>
        <span>↑↓ 选择</span>
        <span>Esc 关闭</span>
        {coverage && <span className="ml-auto truncate text-amber-600 dark:text-amber-500">{coverage}</span>}
        {!coverage && result && result.totalHits > result.totalMessages && (
          <span className="ml-auto tabular-nums">共 {result.totalHits} 处匹配</span>
        )}
      </div>
    </div>
  );
}

/** Mounted once (providers). Listens for the open event and renders the overlay. */
export function GlobalSearchHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenGlobalSearch(() => setOpen(true)), []);
  if (!open) return null;
  return <Overlay onClose={() => setOpen(false)}>{(close) => <SearchPanel close={close} />}</Overlay>;
}
