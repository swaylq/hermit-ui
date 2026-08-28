// Live-preview metadata: the shape of ChatSession.livePreview and its
// validator. Split out of components/chat/preview-panel.tsx so the chat page
// can parse the column without statically importing the panel itself — the
// panel (iframe, drag divider, bridge protocol) is a low-frequency branch and
// loads behind React.lazy.

export interface LivePreviewInfo {
  url: string;
  mode: 'static' | 'proxy';
  target: string;
  updatedAt?: string;
}

/** ChatSession.livePreview is an untyped Json column — validate at the edge. */
export function parseLivePreview(v: unknown): LivePreviewInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) return null;
  return {
    url: o.url,
    mode: o.mode === 'proxy' ? 'proxy' : 'static',
    target: typeof o.target === 'string' ? o.target : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
  };
}
