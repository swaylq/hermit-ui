'use client';

// The lazy file TREE shared by both explorers: one query per expanded directory
// (never recursive), folders-first + capped gateway-side. Parametrized only by the
// `source` (agent dir vs global-memory) and the empty-directory label — every other
// concern (selection, expansion, errors) is lifted to the parent via props.

import {
  Folder, FolderOpen, File as FileIcon, ChevronRight, Loader2,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { type FileSource, type Entry, type Selected, srcInput, joinPath } from './core';

// The children of one directory (also the explorer's root when path=""). Recurses
// into itself for each expanded subfolder.
export function FileTree({
  source, path, depth, expanded, toggleExpand, selectedPath, onSelect, onError, emptyLabel = 'empty',
}: {
  source: FileSource; path: string; depth: number;
  expanded: Set<string>; toggleExpand: (p: string, force?: boolean) => void;
  selectedPath: string | null; onSelect: (s: Selected) => void; onError: (e: string | null) => void;
  emptyLabel?: string;
}) {
  const list = trpc.fileManager.list.useQuery({ ...srcInput(source), path }, { retry: false });
  const indent = depth * 12 + 8;

  if (list.isPending) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /></div>;
  }
  if (list.error) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-rose-500 pr-2 break-words">{list.error.message}</div>;
  }
  const entries = (list.data?.entries ?? []) as Entry[];
  if (entries.length === 0) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-muted-foreground/50">{emptyLabel}</div>;
  }
  return (
    <ul>
      {entries.map((e) => (
        <TreeNode
          key={e.name}
          source={source} entry={e} path={joinPath(path, e.name)} depth={depth}
          expanded={expanded} toggleExpand={toggleExpand} selectedPath={selectedPath} onSelect={onSelect} onError={onError} emptyLabel={emptyLabel}
        />
      ))}
      {list.data?.truncated && (
        <li style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-amber-600">…directory too large, truncated</li>
      )}
    </ul>
  );
}

function TreeNode({
  source, entry, path, depth, expanded, toggleExpand, selectedPath, onSelect, onError, emptyLabel,
}: {
  source: FileSource; entry: Entry; path: string; depth: number;
  expanded: Set<string>; toggleExpand: (p: string, force?: boolean) => void;
  selectedPath: string | null; onSelect: (s: Selected) => void; onError: (e: string | null) => void;
  emptyLabel?: string;
}) {
  const isDir = entry.type === 'dir';
  const isOpen = expanded.has(path);
  const isSel = selectedPath === path;
  const indent = depth * 12 + 8;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => { onSelect({ path, name: entry.name, type: entry.type, size: entry.size }); if (isDir) toggleExpand(path); }}
        style={{ paddingLeft: indent }}
        className={cn(
          'group flex items-center gap-1 pr-1.5 h-7 cursor-pointer text-sm select-none',
          isSel ? 'bg-accent text-foreground' : 'hover:bg-accent/40 text-foreground/85',
        )}
      >
        {isDir ? (
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isDir ? (
          isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-sky-500" /> : <Folder className="h-4 w-4 shrink-0 text-sky-500" />
        ) : (
          <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate flex-1">{entry.name}</span>
      </div>
      {isDir && isOpen && (
        <FileTree
          source={source} path={path} depth={depth + 1}
          expanded={expanded} toggleExpand={toggleExpand} selectedPath={selectedPath} onSelect={onSelect} onError={onError} emptyLabel={emptyLabel}
        />
      )}
    </li>
  );
}
