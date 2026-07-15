'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

// ── In-chat find ─────────────────────────────────────────────────────────────
// Cmd/Ctrl+F search scoped to the OPEN session. Matches are computed over the
// rendered text in the scroll viewport — so it finds exactly what you see (full
// or summary view, the loaded window) — and painted with the CSS Custom
// Highlight API (overlay Ranges, no DOM mutation, survives React re-renders).
// ↑/↓ or Enter / Shift+Enter step matches; Esc closes.
const HL_CTOR: any = typeof window !== 'undefined' ? (window as any).Highlight : undefined;
const HL_REG: any = typeof CSS !== 'undefined' ? (CSS as any).highlights : undefined;
const HL_OK = !!HL_CTOR && !!HL_REG;
// Only realize Ranges for the current match ±HL_WINDOW. A 1-char query can match
// thousands of nodes; building+registering a Range for every one janks the frame.
// The index below stays lightweight ({node,start}), so count + navigation cover
// all matches while paint cost is bounded to ~2·HL_WINDOW regardless of total.
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

export function ChatFind({ getViewport, onClose }: { getViewport: () => HTMLElement | null; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [pos, setPos] = useState(0); // 1-based current match (0 = none)
  const matchesRef = useRef<Array<{ node: Text; start: number }>>([]);
  const qLenRef = useRef(0);
  const posRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Realize Ranges only for the current match ±HL_WINDOW and re-center on every
  // step, so the painted band follows wherever you are. For ≤2·HL_WINDOW matches
  // the window covers them all — visually identical to highlighting everything.
  const paint = useCallback((idx0: number) => {
    if (!HL_OK) return;
    const ms = matchesRef.current;
    if (ms.length === 0) { HL_REG.delete('chat-find'); HL_REG.delete('chat-find-current'); return; }
    const lo = Math.max(0, idx0 - HL_WINDOW);
    const hi = Math.min(ms.length - 1, idx0 + HL_WINDOW);
    const ranges: Range[] = [];
    for (let i = lo; i <= hi; i++) {
      const r = rangeFrom(ms[i].node, ms[i].start, qLenRef.current);
      if (r) ranges.push(r);
    }
    if (ranges.length) HL_REG.set('chat-find', new HL_CTOR(...ranges));
    else HL_REG.delete('chat-find');
    const cur = ms[idx0] ? rangeFrom(ms[idx0].node, ms[idx0].start, qLenRef.current) : null;
    if (cur) HL_REG.set('chat-find-current', new HL_CTOR(cur));
    else HL_REG.delete('chat-find-current');
  }, []);

  const clearHl = useCallback(() => {
    if (HL_OK) { HL_REG.delete('chat-find'); HL_REG.delete('chat-find-current'); }
    matchesRef.current = [];
  }, []);

  const scrollToCurrent = useCallback(() => {
    const root = getViewport();
    const m = matchesRef.current[posRef.current - 1];
    if (!root || !m) return;
    const r = rangeFrom(m.node, m.start, qLenRef.current);
    if (!r) return;
    const rect = r.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // detached / not laid out
    const vp = root.getBoundingClientRect();
    root.scrollTop += rect.top - vp.top - vp.height / 2 + rect.height / 2;
  }, [getViewport]);

  const recompute = useCallback((scroll: boolean) => {
    const root = getViewport();
    const q = query.trim().toLowerCase();
    if (!root || !q) { clearHl(); setCount(0); setPos(0); posRef.current = 0; return; }
    // Cheap pass: record each match's location only — no Range/Highlight here.
    // Thousands of {node,start} tuples cost microseconds; the heavy Range work is
    // deferred to paint()'s bounded window, so a 1-char query no longer janks.
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
    matchesRef.current = matches;
    qLenRef.current = q.length;
    setCount(matches.length);
    if (matches.length === 0) { clearHl(); setPos(0); posRef.current = 0; return; }
    let next = posRef.current;
    if (next < 1 || next > matches.length) next = 1;
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
    const n = matchesRef.current.length;
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
