'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { useChatSearch } from '@/lib/chat-cache/use-chat-cache';

// ── In-chat find ─────────────────────────────────────────────────────────────
// Cmd/Ctrl+F search scoped to the OPEN session — over the WHOLE session, not
// just what's on screen.
//
// It runs on two tracks, and the split is the point:
//   · The COUNT and the ↑/↓ navigation come from the local prose cache, so
//     "3 / 47" counts every match in the session, including the messages that
//     were never loaded. Stepping onto a match outside the rendered window calls
//     `onJump`, which re-centres the timeline on that message.
//   · The HIGHLIGHTS are painted over the rendered DOM with the CSS Custom
//     Highlight API (overlay Ranges, no DOM mutation, survives React
//     re-renders). Only what's rendered can be painted — which is fine, since
//     only what's rendered can be seen.
//
// Before the cache existed this was DOM-only, so the count silently meant
// "matches among the newest 60 messages" and the rest of the session was
// unreachable. The DOM pass still paints; it no longer counts.
const HL_CTOR: any = typeof window !== 'undefined' ? (window as any).Highlight : undefined;
const HL_REG: any = typeof CSS !== 'undefined' ? (CSS as any).highlights : undefined;
const HL_OK = !!HL_CTOR && !!HL_REG;
// Only realize Ranges for the current match ±HL_WINDOW. A 1-char query can match
// thousands of nodes; building+registering a Range for every one janks the frame.
// The index stays lightweight ({node,start}), so paint cost is bounded to
// ~2·HL_WINDOW no matter how many matches are on screen.
const HL_WINDOW = 100;
function rangeFrom(node: Text, start: number, len: number): Range | null {
  try {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, start + len);
    return r;
  } catch {
    return null; // node went stale between index build and paint — skip it
  }
}

export function ChatFind({
  sessionId,
  getViewport,
  onJump,
  onClose,
}: {
  sessionId: string;
  getViewport: () => HTMLElement | null;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(0); // 1-based position among the session's matches
  const domMatchesRef = useRef<Array<{ node: Text; start: number }>>([]);
  const qLenRef = useRef(0);
  const posRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Authoritative match list: every message in THIS session, chronological so
  // ↑/↓ walk the conversation in the direction it scrolls.
  const { result, searching } = useChatSearch(query, { sessionId, limit: 0, order: 'chronological' });
  const hits = result?.hits ?? [];
  const count = hits.length;

  // A settled result set resets the position to the first match. Adjusted during
  // render so the "1 / 47" readout can never disagree with the list it counts.
  const resultQuery = result?.query ?? null;
  const [posFor, setPosFor] = useState<string | null>(null);
  if (posFor !== resultQuery) {
    setPosFor(resultQuery);
    setPos(count > 0 ? 1 : 0);
  }

  // Mirrors for the callbacks and the MutationObserver, which must see the
  // latest values without re-subscribing every render. Written after render —
  // refs are not writable during it.
  const hitsRef = useRef(hits);
  useEffect(() => {
    hitsRef.current = hits;
    posRef.current = pos;
  });

  // ── DOM pass (paint only) ──────────────────────────────────────────────────
  const paint = useCallback((centerIdx: number) => {
    if (!HL_OK) return;
    const ms = domMatchesRef.current;
    if (ms.length === 0) { HL_REG.delete('chat-find'); return; }
    const idx0 = Math.max(0, Math.min(ms.length - 1, centerIdx));
    const lo = Math.max(0, idx0 - HL_WINDOW);
    const hi = Math.min(ms.length - 1, idx0 + HL_WINDOW);
    const ranges: Range[] = [];
    for (let i = lo; i <= hi; i++) {
      const r = rangeFrom(ms[i].node, ms[i].start, qLenRef.current);
      if (r) ranges.push(r);
    }
    if (ranges.length) HL_REG.set('chat-find', new HL_CTOR(...ranges));
    else HL_REG.delete('chat-find');
  }, []);

  const clearHl = useCallback(() => {
    if (HL_OK) { HL_REG.delete('chat-find'); HL_REG.delete('chat-find-current'); }
    domMatchesRef.current = [];
  }, []);

  // Index the rendered text. Cheap: thousands of {node,start} tuples cost
  // microseconds; Range construction is deferred to paint()'s bounded window.
  const indexDom = useCallback(() => {
    const root = getViewport();
    const q = query.trim().toLowerCase();
    if (!root || !q) { clearHl(); return; }
    const matches: Array<{ node: Text; start: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const hay = node.nodeValue!.toLowerCase();
      let i = hay.indexOf(q);
      while (i !== -1) {
        matches.push({ node: node as Text, start: i });
        i = hay.indexOf(q, i + q.length);
      }
    }
    domMatchesRef.current = matches;
    qLenRef.current = q.length;
  }, [query, getViewport, clearHl]);

  // Scroll to the rendered occurrence inside `messageId` and mark it current.
  // Returns false when that message isn't in the DOM — the caller then jumps.
  const focusInDom = useCallback(
    (messageId: string): boolean => {
      const root = getViewport();
      if (!root) return false;
      const host = root.querySelector(`[data-msg-id~="${CSS.escape(messageId)}"]`);
      if (!host) return false;
      const q = query.trim().toLowerCase();
      const idx = domMatchesRef.current.findIndex((m) => host.contains(m.node));
      const hit = idx === -1 ? null : domMatchesRef.current[idx];
      if (!hit || !q) {
        host.scrollIntoView({ block: 'center' });
        return true;
      }
      const r = rangeFrom(hit.node, hit.start, q.length);
      if (!r) { host.scrollIntoView({ block: 'center' }); return true; }
      if (HL_OK) HL_REG.set('chat-find-current', new HL_CTOR(r));
      const rect = r.getBoundingClientRect();
      const vp = root.getBoundingClientRect();
      if (rect.width || rect.height) root.scrollTop += rect.top - vp.top - vp.height / 2 + rect.height / 2;
      else host.scrollIntoView({ block: 'center' });
      paint(idx); // centre the painted band on this match
      return true;
    },
    [getViewport, query, paint]
  );

  const goTo = useCallback(
    (next: number) => {
      const list = hitsRef.current;
      if (list.length === 0) return;
      const wrapped = next < 1 ? list.length : next > list.length ? 1 : next;
      posRef.current = wrapped;
      setPos(wrapped);
      const target = list[wrapped - 1];
      if (!target) return;
      indexDom();
      if (!focusInDom(target.id)) onJump(target.id); // outside the loaded window
    },
    [indexDom, focusInDom, onJump]
  );

  // A settled query moves the viewport to the first match. The POSITION was
  // already reset during render; this is the DOM half of it. Keyed on the
  // RESULT's query (not the input) so it fires once per completed search, not
  // per keystroke — and deliberately NOT on `hits`/callbacks, whose identity
  // changes every poll tick and would yank the user back to match 1 mid-navigation.
  useEffect(() => {
    if (count === 0) {
      clearHl();
      return;
    }
    indexDom();
    const target = hitsRef.current[0];
    if (target && !focusInDom(target.id)) onJump(target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultQuery, count]);

  // Rendered content changed (streaming / load-earlier / an anchor jump landing)
  // → re-index and re-paint at the current position, without moving the user.
  useEffect(() => {
    const root = getViewport();
    if (!root) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const mo = new MutationObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        indexDom();
        const target = hitsRef.current[posRef.current - 1];
        if (target) focusInDom(target.id);
        else paint(0);
      }, 200);
    });
    mo.observe(root, { childList: true, characterData: true, subtree: true });
    return () => { mo.disconnect(); if (t) clearTimeout(t); };
  }, [getViewport, indexDom, focusInDom, paint]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => () => clearHl(), [clearHl]); // clear highlights on close

  const navBtn = 'inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-default cursor-pointer';
  return (
    <div className="border-b border-border bg-background px-3 h-11 flex items-center gap-2 shrink-0">
      <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); goTo(posRef.current + (e.shiftKey ? -1 : 1)); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        placeholder="在本会话中查找…"
        aria-label="find in conversation"
        className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-muted-foreground/60"
      />
      <span className="shrink-0 min-w-12 text-right text-xs font-mono tabular-nums text-muted-foreground">
        {!query.trim() ? '' : searching && !result ? '…' : `${pos}/${count}`}
      </span>
      <button type="button" className={navBtn} onClick={() => goTo(posRef.current - 1)} disabled={count === 0} aria-label="previous match" title="上一个 · Shift+Enter">
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" className={navBtn} onClick={() => goTo(posRef.current + 1)} disabled={count === 0} aria-label="next match" title="下一个 · Enter">
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" className={navBtn} onClick={onClose} aria-label="close find" title="关闭 · Esc">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
