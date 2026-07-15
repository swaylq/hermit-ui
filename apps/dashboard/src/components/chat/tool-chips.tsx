'use client';

// Tool-call rendering for the chat timeline: the collapsible request chips
// (ToolChip / ToolBatchChip) and their inline results (InlineToolResult /
// InlineToolResultBatch), plus the one-line argument formatter oneLineArg (also
// used by InteractionCard). Pure presentational — consumed by the message
// renderers back in chat/page.tsx. Extracted from that god-file (P2-3), behaviour
// identical.

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

// Modern minimal chip surface — hairline border, no fills, no shadows.
function chipSurface(_dark: boolean, _inline: boolean): string {
  return 'min-w-0 max-w-full overflow-hidden border border-border bg-background hover:border-foreground/30 hover:bg-accent/40 transition-colors';
}

export function ToolChip({ call, dark, inline = false }: { call: { id: string; name: string; input: any }; dark: boolean; inline?: boolean }) {
  const argPreview = useMemo(() => oneLineArg(call.input), [call.input]);
  return (
    <details className={`group rounded text-[11px] ${chipSurface(dark, inline)}`}>
      <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2 py-1 font-mono">
        <span className="text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{call.name}</span>
        {argPreview && <span className="text-muted-foreground truncate max-w-[32ch]">{argPreview}</span>}
      </summary>
      <pre className="mt-0 mx-0 border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap break-all bg-muted/40 text-foreground/80 rounded-b">
        {JSON.stringify(call.input, null, 2)}
      </pre>
    </details>
  );
}

export function ToolBatchChip({ name, calls, dark, inline = false }: { name: string; calls: Array<{ id: string; name: string; input: any }>; dark: boolean; inline?: boolean }) {
  return (
    <details className={`group rounded text-[11px] ${chipSurface(dark, inline)}`}>
      <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2 py-1 font-mono">
        <span className="text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{name}</span>
        <span className="text-muted-foreground tabular-nums">× {calls.length}</span>
      </summary>
      <ul className="border-t border-border divide-y divide-border">
        {calls.map((c, i) => {
          const arg = oneLineArg(c.input);
          return (
            <li key={c.id || `${name}-${i}`} className="px-2 py-1 bg-muted/20">
              <details>
                <summary className="cursor-pointer list-none font-mono text-[11px] flex items-center gap-1.5">
                  <span className="text-muted-foreground/60 tabular-nums">{i + 1}.</span>
                  <span className="text-foreground/80 truncate">{arg || '(no arg)'}</span>
                </summary>
                <pre className="mt-1 px-2 py-1.5 rounded text-[10px] whitespace-pre-wrap break-all bg-muted/60 text-foreground/80">
                  {JSON.stringify(c.input, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function InlineToolResult({ block }: { block: { type: string; tool_use_id?: string; content?: any; is_error?: boolean } }) {
  const text = useMemo(() => extractToolResultText(block.content), [block.content]);
  const isError = !!block.is_error;
  return (
    <details className={cn(
      'min-w-0 max-w-full overflow-hidden rounded text-[11px] border bg-background transition-colors',
      isError
        ? 'border-rose-500/40 bg-rose-500/5'
        : 'border-border hover:border-foreground/30',
    )}>
      <summary className="cursor-pointer list-none px-2 py-1 font-mono flex items-center gap-1.5">
        <span className={isError ? 'text-rose-500' : 'text-muted-foreground/70'}>←</span>
        <span className="text-foreground/80">result</span>
        <span className="text-muted-foreground truncate max-w-[60ch]">{firstLine(text)}</span>
      </summary>
      <pre className="border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap break-all bg-muted/40 text-foreground/80 rounded-b">
        {text}
      </pre>
    </details>
  );
}

export function InlineToolResultBatch({ results }: { results: Array<{ type: string; tool_use_id?: string; content?: any; is_error?: boolean }> }) {
  const errCount = results.filter((r) => r.is_error).length;
  const ok = errCount === 0;
  return (
    <details className={cn(
      'min-w-0 max-w-full overflow-hidden rounded text-[11px] border bg-background transition-colors',
      ok ? 'border-border hover:border-foreground/30' : 'border-rose-500/40 bg-rose-500/5',
    )}>
      <summary className="cursor-pointer list-none px-2 py-1 font-mono flex items-center gap-1.5">
        <span className={ok ? 'text-muted-foreground/70' : 'text-rose-500'}>←</span>
        <span className="text-foreground/80 tabular-nums">{results.length} results</span>
        {errCount > 0 && <span className="text-rose-500 tabular-nums">· {errCount} error{errCount > 1 ? 's' : ''}</span>}
      </summary>
      <div className="border-t border-border p-1.5 space-y-1 bg-muted/20 rounded-b">
        {results.map((b, i) => (
          <InlineToolResult key={i} block={b} />
        ))}
      </div>
    </details>
  );
}

export function oneLineArg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  // Path-shaped fields get tail-truncation so the basename stays visible —
  // `…/long/path/foo.tsx` is more informative than `/Users/mac/…`.
  for (const k of ['file_path', 'path']) {
    if (typeof input[k] === 'string') return shortenPath(input[k]);
  }
  // URLs, commands, etc. stay head-anchored.
  for (const k of ['url', 'command', 'pattern', 'query', 'name', 'text']) {
    if (typeof input[k] === 'string') return shorten(input[k]);
  }
  // Fall back to first string value.
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return shorten(v);
  }
  return '';
}
function shorten(s: string, n = 60) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
// Keep file basename visible — chip width is small, and basename + nearest
// parent dir is what readers actually scan for. We pad with the parent dir
// when we have room (e.g. `…/components/markdown.tsx`).
function shortenPath(p: string, n = 48): string {
  if (p.length <= n) return p;
  const parts = p.split('/');
  const tail = parts.slice(-2).join('/');
  if (tail.length <= n - 1) return '…/' + tail;
  // Last segment alone is still too long — fall back to head trunc.
  return shorten(parts[parts.length - 1], n);
}
function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return shorten(i >= 0 ? s.slice(0, i) : s, 80);
}
function extractToolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content ?? {}, null, 2);
}
