// Shared core for the two-pane file explorer used by both the agent "Files" tab
// (agent-files.tsx) and this machine's global-memory folder manager
// (global-memory-files.tsx): the source abstraction (an agent's own directory XOR
// the machine-global memory folder), the pure path/size helpers, and the
// prepared-download path (gateway → dashboard stash → blob). The lazy tree lives in
// ./file-tree; the capability-divergent panes (upload vs authoring, the inline
// note) stay in each component for now.

import type { trpc } from '@/lib/trpc';
import { authedFetch } from '@/lib/asst-fetch';

// The fileManager tRPC input is a flat { agentName?, globalMemory?, path } (NOT a
// discriminated union — see server/routers/fileManager.ts PathInput), so a source
// just contributes the right discriminant field to spread into every call.
export type FileSource =
  | { kind: 'agent'; agentName: string }
  | { kind: 'globalMemory' };

// The { agentName } | { globalMemory: true } fragment for this source.
export function srcInput(source: FileSource): { agentName: string } | { globalMemory: true } {
  return source.kind === 'agent' ? { agentName: source.agentName } : { globalMemory: true };
}

export type Entry = { name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number };
export type Selected = { path: string; name: string; type: 'dir' | 'file' | 'other'; size: number } | null;

// Human-readable byte size. ONE canonical impl — the two components had drifted
// (global-memory stopped at MB, agent went to GB); this is the GB-capable version.
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const joinPath = (base: string, name: string) => (base ? `${base}/${name}` : name);
export const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export const PREVIEW_IMG_MAX = 25 * 1024 * 1024; // auto-preview images up to 25 MB; bigger → download only

// prepareDownload's mutateAsync — either source's discriminant is accepted by the
// flat input, so this type covers both call sites.
export type PrepareAsync = (
  vars: { agentName?: string; globalMemory?: boolean; path: string; isFolder: boolean },
) => Promise<{ id: string }>;

// Fetch a prepared download (a file, or a gateway-zipped folder) as a Blob: trigger
// the gateway prepare, poll until it's stashed, then pull the bytes. Shared by the
// download action and the inline image preview.
export async function fetchPreparedBlob(
  source: FileSource,
  path: string,
  isFolder: boolean,
  utils: ReturnType<typeof trpc.useUtils>,
  prepareAsync: PrepareAsync,
): Promise<{ blob: Blob; filename: string }> {
  const { id } = await prepareAsync({ ...srcInput(source), path, isFolder });
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const s = await utils.fileManager.downloadStatus.fetch({ id });
    if (s.status === 'ready') {
      const res = await authedFetch(`/api/file-manager/download/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      return { blob: await res.blob(), filename: s.filename };
    }
    if (s.status === 'error') throw new Error(s.error || 'Prepare failed');
  }
  throw new Error('Timed out');
}

// Save a prepared download to disk (synthetic anchor — the key can't ride <a>).
export async function pullDownload(
  source: FileSource,
  path: string,
  isFolder: boolean,
  fallbackName: string,
  utils: ReturnType<typeof trpc.useUtils>,
  prepareAsync: PrepareAsync,
): Promise<void> {
  const { blob, filename } = await fetchPreparedBlob(source, path, isFolder, utils, prepareAsync);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
