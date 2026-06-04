'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';

// A file shown as a flat list row; clicking opens a portal modal to read the
// rendered markdown and — when `onSave` is given — edit it. Mirrors the agent
// detail's file list (components/agent-detail-sheet.tsx) so /skills and /agents
// look and behave identically. The modal is presentational: it calls
// `onSave(content)` (an async mutation) and the parent owns the write + cache
// invalidation. Bare createPortal (NOT base-ui Dialog) per the overlay gotcha;
// the detail renders inside ordinary pages (no focus trap to fight).
export type FileItem = {
  key: string;
  label: string;
  body: string | null;
  monoLabel?: boolean;
  // Present ⇒ editable. Returns the save promise so the modal can await it, leave
  // edit mode on success, and surface an error on failure. Omit for read-only.
  onSave?: (content: string) => Promise<unknown>;
};

function fmtSize(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function FileList({ items }: { items: FileItem[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Derive the open item from the LIVE items each render so an edit + re-sync
  // refreshes the modal body instead of pinning the click-time snapshot.
  const openItem = items.find((i) => i.key === openKey && i.body != null) ?? null;
  return (
    <>
      <div className="space-y-1.5">
        {items.map((it) => (
          <FileRow key={it.key} item={it} onClick={() => setOpenKey(it.key)} />
        ))}
      </div>
      <DetailModal item={openItem} onClose={() => setOpenKey(null)} />
    </>
  );
}

function FileRow({ item, onClick }: { item: FileItem; onClick: () => void }) {
  if (!item.body) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded border border-dashed text-xs text-muted-foreground/60">
        <span className={cn('truncate', item.monoLabel ? 'font-mono' : 'uppercase tracking-wide')}>{item.label}</span>
        <span className="text-muted-foreground/40">— empty</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded border bg-card hover:bg-accent/40 hover:border-foreground/30 transition-colors cursor-pointer text-left"
    >
      <span className={cn('truncate text-sm text-foreground/90', item.monoLabel && 'font-mono text-[13px]')}>{item.label}</span>
      <span className="shrink-0 text-[11px] font-mono text-muted-foreground/60 tabular-nums">{fmtSize(item.body.length)}</span>
    </button>
  );
}

function DetailModal({ item, onClose }: { item: FileItem | null; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editable = !!item?.onSave;

  // Reset transient state whenever the open file changes (or the modal closes).
  useEffect(() => {
    setEditing(false);
    setDraft('');
    setErr(null);
    setSavedHint(false);
  }, [item?.key]);

  // Esc + scroll-lock while open. Esc backs out one level: cancel an in-progress
  // edit first, otherwise close the modal.
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) { setEditing(false); setDraft(''); } else onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [item, editing, onClose]);

  if (!item || item.body == null) return null;
  const body = item.body;

  const dismiss = () => {
    if (editing) { setEditing(false); setDraft(''); } else onClose();
  };

  const doSave = async () => {
    if (!item.onSave) return;
    setErr(null);
    setSaving(true);
    try {
      await item.onSave(draft);
      setEditing(false);
      setSavedHint(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60"
      onClick={dismiss}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
          <span className={cn('text-sm font-medium truncate', item.monoLabel && 'font-mono')}>{item.label}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {saving && <span className="text-[10px] text-muted-foreground animate-pulse">saving…</span>}
            {editable && !editing && (
              <button
                type="button"
                onClick={() => { setDraft(body); setEditing(true); setSavedHint(false); }}
                title={`edit ${item.label}`}
                aria-label={`edit ${item.label}`}
                className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 text-sm">
          {editing ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(32, Math.max(12, draft.split('\n').length + 1))}
                className="w-full font-mono text-[12px] leading-relaxed bg-background border border-border rounded-md px-2 py-1.5 outline-none focus:border-foreground/30 resize-y"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={doSave}
                  disabled={saving || draft === body}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium bg-foreground text-background hover:bg-foreground/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Check className="h-3.5 w-3.5" /> {saving ? 'saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setDraft(''); }}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs text-muted-foreground hover:bg-accent cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" /> cancel
                </button>
                {err && <span className="text-[11px] text-rose-500">{err}</span>}
              </div>
            </div>
          ) : (
            <>
              {savedHint && (
                <div className="mb-2 text-[11px] text-muted-foreground">已提交 — 网关写入后内容会自动刷新。</div>
              )}
              <Markdown>{body}</Markdown>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
