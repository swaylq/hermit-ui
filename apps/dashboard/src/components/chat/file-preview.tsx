'use client';

// Attachment rendering for the chat timeline: ChatImage (a capped thumbnail that
// opens a zoomable lightbox) and ChatFile (an agent-attached file that previews
// renderable types in an in-app overlay, else downloads via the share sheet /
// object-URL). The classify/preview internals (TEXT_EXT / classifyFile /
// FilePreviewBody) stay private to this module. Extracted verbatim from
// chat/page.tsx (P2-3); behaviour identical. Consumed by GroupView back there.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { FileText, Download, X } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { ImageLightbox } from '@/components/ui/image-lightbox';
import { saveFile } from '@/lib/save-file';
import { Overlay } from '@/components/overlay';

// A chat image: a capped thumbnail that opens a zoomable full-screen lightbox
// on click (instead of yanking the user to the raw file in a new tab).
export function ChatImage({ url, width, height }: { url: string; width: number | null; height: number | null }) {
  const [open, setOpen] = useState(false);
  const alt = `attachment${width && height ? ` ${width}×${height}` : ''}`;
  return (
    <>
      <button
        type="button"
        data-lightbox-src={url}
        onClick={() => setOpen(true)}
        aria-label="view image"
        className="inline-block cursor-zoom-in overflow-hidden rounded border border-border align-bottom transition-opacity hover:opacity-90"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={alt} className="max-h-[320px] max-w-[320px]" loading="lazy" />
      </button>
      <ImageLightbox open={open} onOpenChange={setOpen} url={url} alt={alt} siblingSelector="[data-lightbox-src]" />
    </>
  );
}

// saveAttachment → saveFile (@/lib/save-file): fetch → Blob → native share sheet
// on touch (iOS/Android "Save to Files"), else object-URL download on desktop —
// never navigating the PWA away. Shared with the image lightbox's Save action.

// File extensions a browser renders inline (→ would navigate the PWA on a plain
// link). These get an in-app preview overlay instead of a download.
const TEXT_EXT = new Set([
  'txt','text','md','markdown','csv','tsv','json','yaml','yml','xml','log','sql',
  'ini','conf','cfg','toml','env','js','mjs','cjs','ts','tsx','jsx','css','scss',
  'py','sh','bash','zsh','c','h','cpp','hpp','cc','java','go','rs','rb','php','lua','r','kt','swift','pl',
]);

function classifyFile(name: string, mimeType: string | null) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const mt = (mimeType || '').toLowerCase();
  const isHtml = mt.includes('html') || ext === 'html' || ext === 'htm';
  const isSvg = mt.includes('svg') || ext === 'svg';
  const isPdf = mt.includes('pdf') || ext === 'pdf';
  const isMarkdown = ext === 'md' || ext === 'markdown';
  const isText = !isHtml && !isSvg && (mt.startsWith('text/') || TEXT_EXT.has(ext));
  return { isHtml, isSvg, isPdf, isText, isMarkdown, previewable: isHtml || isSvg || isPdf || isText };
}

// Lazily fetch + render an attachment INSIDE the overlay, independent of how the
// server labels its content-type (the dev /uploads route serves everything as
// octet-stream; prod Caddy sends real types). So we don't trust the header:
//   · html → fetch text, render via iframe `srcDoc` + sandbox="allow-scripts"
//            (scripts run in an opaque origin; cannot navigate the top frame)
//   · text → fetch text, render as Markdown (.md) or a <pre>
//   · svg / pdf → typed Blob URL (image/svg+xml · application/pdf) so it renders
//     regardless of the served content-type
function FilePreviewBody({ url, name, c }: { url: string; name: string; c: ReturnType<typeof classifyFile> }) {
  const [html, setHtml] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    setHtml(null); setText(null); setBlobUrl(null); setError(null);
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then(async (blob) => {
        if (!alive) return;
        if (c.isHtml) { const t = await blob.text(); if (alive) setHtml(t); return; }
        if (c.isText) {
          const t = await blob.text();
          if (alive) setText(t.length > 200_000 ? `${t.slice(0, 200_000)}\n…(truncated)` : t);
          return;
        }
        const type = c.isSvg ? 'image/svg+xml' : c.isPdf ? 'application/pdf' : (blob.type || 'application/octet-stream');
        created = URL.createObjectURL(new Blob([blob], { type }));
        if (alive) setBlobUrl(created); else URL.revokeObjectURL(created);
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; if (created) URL.revokeObjectURL(created); };
  }, [url, c]);

  const loading = <div className="p-4 text-xs text-muted-foreground">loading…</div>;
  if (error) return <div className="p-4 text-xs text-rose-500">Failed to load: {error}</div>;

  if (c.isHtml) {
    if (html == null) return loading;
    return <iframe srcDoc={html} title={name} sandbox="allow-scripts" className="h-full w-full border-0 bg-white" />;
  }
  if (c.isText) {
    if (text == null) return loading;
    if (c.isMarkdown) return <div className="p-4 text-sm"><Markdown>{text}</Markdown></div>;
    return <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words text-foreground/90">{text}</pre>;
  }
  if (blobUrl == null) return loading;
  if (c.isSvg) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={blobUrl} alt={name} className="max-h-full max-w-full" />
      </div>
    );
  }
  return <iframe src={blobUrl} title={name} className="h-full w-full border-0" />; // pdf
}

// An agent-attached file (attach_file). Clicking a RENDERABLE file (html / svg /
// pdf / text) opens an in-app preview overlay — never a navigation — so the chat
// is always one Close away. Other types (office docs, archives) download in place
// via the share sheet / object-URL. Fixes the standalone-PWA "no way back" trap.
export function ChatFile({ url, name, mimeType }: { url: string; name: string; mimeType: string | null }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const c = useMemo(() => classifyFile(name, mimeType), [name, mimeType]);

  const save = useCallback(async () => {
    setSaving(true);
    try { await saveFile(url, name, mimeType); }
    catch { /* swallow — rare; the user can retry */ }
    finally { setSaving(false); }
  }, [url, name, mimeType]);

  return (
    <>
      <button
        type="button"
        onClick={() => (c.previewable ? setOpen(true) : void save())}
        title={c.previewable ? `Preview ${name}` : `Download ${name}`}
        className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs transition-colors hover:border-foreground/30 hover:bg-accent/40 cursor-pointer"
      >
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground/90">{name}</span>
      </button>

      {open && (
        <Overlay
          onClose={() => setOpen(false)}
          panelClassName="flex h-[88vh] w-[96vw] max-w-[1100px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        >
          {(close) => (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground transition-colors hover:bg-accent/40 disabled:opacity-50 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" /> {saving ? '…' : 'Download'}
                </button>
                <button
                  type="button"
                  onClick={close}
                  aria-label="close preview"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-background">
                <FilePreviewBody url={url} name={name} c={c} />
              </div>
            </>
          )}
        </Overlay>
      )}
    </>
  );
}
