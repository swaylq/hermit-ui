'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Overlay } from './overlay';
import { FileList, type FileItem } from './file-detail';

// Unified skill popup: a skill's SKILL.md + its full file tree, rendered with the
// shared FileList (same rows + view/edit modal as the /skills and /agents file
// views). Used by BOTH the agent detail sheet and the marketplace skill detail so
// a skill looks and behaves the same everywhere. `headerExtra` slots extra
// controls above the file list (e.g. the marketplace's version selector / diff).
export function SkillFilesModal({
  title,
  subtitle,
  headerExtra,
  items,
  body,
  loading,
  onClose,
}: {
  title: string;
  subtitle?: string;
  headerExtra?: ReactNode;
  items: FileItem[];
  // When given, replaces the file list (e.g. the marketplace's version diff).
  body?: ReactNode;
  loading?: boolean;
  onClose: () => void;
}) {
  return (
    <Overlay
      onClose={onClose}
      z={100}
      panelClassName="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl"
    >
      {(close) => (
        <>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{title}</div>
              {subtitle && (
                <div className="text-[11px] font-mono text-muted-foreground/70 truncate">{subtitle}</div>
              )}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="close"
              className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3">
            {headerExtra}
            {body ?? <FileList items={items} />}
            {loading && <div className="px-1 text-[11px] text-muted-foreground/60">加载其余文件…</div>}
          </div>
        </>
      )}
    </Overlay>
  );
}
