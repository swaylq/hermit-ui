/**
 * Draw the REAL attachment strip to a self-contained HTML file — no database, no
 * dev server, no browser — as the web half of the comparison whose native half
 * is `apps/ios/tools/render-attach.sh`.
 *
 *   pnpm --filter @hermit-ui/dashboard render:attachments <out.html> [dark|light]
 *
 * Same bargain as `render-queue-bar.tsx`: this imports `AttachmentStrip` from
 * `components/chat/composer.tsx` — the component the dashboard ships — rather
 * than restating its markup, so a difference the diff finds is a difference
 * between the port and the app.
 *
 * Both sides read `apps/ios/tools/fixtures/attach-strip.json`, INCLUDING the
 * thumbnail: it rides in the table as base64 so there is no way for the two
 * halves to draw different pictures. In the app that url is an object-URL for
 * the local file; here it is a data: URI, which `<img src>` treats identically.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { AttachmentStrip } from '@/components/chat/composer';
import type { Attachment } from '@/components/chat/lib';

const HERE = __dirname;
const FIXTURE = process.env.HERMIT_ATTACH_FIXTURE
  ?? resolve(HERE, '../../ios/tools/fixtures/attach-strip.json');
const GLOBALS = resolve(HERE, '../src/app/globals.css');

interface FixtureChip {
  id: string;
  name: string;
  isImage: boolean;
  kind: 'uploading' | 'ready' | 'error';
  error?: string;
  mimeType?: string;
  width?: number | null;
  height?: number | null;
  preview?: boolean;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  width: number;
  gap: number;
  preview: string;
  cases: { why: string; chips: FixtureChip[] }[];
};

const dataURI = `data:image/png;base64,${fixture.preview}`;

function toAttachment(c: FixtureChip): Attachment {
  const previewUrl = c.preview ? dataURI : null;
  if (c.kind === 'error') {
    // The web's error variant is a DIFFERENT SHAPE — no previewUrl, no isImage.
    // That is why a failed image upload shows the `!` plate and never a greyed
    // photograph, and the fixture has to reproduce the shape, not just the kind.
    return { id: c.id, kind: 'error', name: c.name, error: c.error ?? '' };
  }
  if (c.kind === 'uploading') {
    return { id: c.id, kind: 'uploading', name: c.name, isImage: c.isImage, previewUrl };
  }
  return {
    id: c.id, kind: 'ready', name: c.name, isImage: c.isImage, previewUrl,
    data: {
      url: `/uploads/x/${c.id}`,
      mimeType: c.mimeType ?? '',
      width: c.width ?? null,
      height: c.height ?? null,
    },
  };
}

const noop = () => {};

const html = renderToStaticMarkup(
  <>
    {fixture.cases.map((c, i) => (
      <div key={i} style={{ paddingBottom: i === fixture.cases.length - 1 ? 0 : `${fixture.gap}px` }}>
        <AttachmentStrip attachments={c.chips.map(toAttachment)} onRemove={noop} />
      </div>
    ))}
  </>,
);

const out = process.argv[2] ?? 'attachments.html';
const scheme = process.argv[3] === 'light' ? 'light' : 'dark';

async function main(): Promise<void> {
  const css = await postcss([tailwind()]).process(readFileSync(GLOBALS, 'utf8'), { from: GLOBALS });
  writeFileSync(
    out,
    `<!doctype html>
<html class="${scheme === 'dark' ? 'dark' : ''}" style="color-scheme:${scheme}">
<head><meta charset="utf-8"><title>attachments — ${scheme}</title>
<style>${css.css}</style>
<style>
  /* The real faces come from next/font at build time and the native side draws
     with the system face anyway; comparing SF Pro against a missing webfont
     measures nothing. */
  :root { --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
          --font-geist-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; }
  html, body { margin: 0; padding: 0; }
  body { font-family: var(--font-sans); -webkit-font-smoothing: antialiased;
         background: var(--background); }
  /* The chips mount with an entry animation (animate-in fade-in-0 zoom-in-95).
     A static render never runs it, but tailwindcss-animate's keyframes still
     apply the START state to the element — so without this the whole strip is
     invisible and 95% scaled. The end state is the only one worth comparing;
     the native side draws no animation in a still either. */
  #frame .animate-in { animation: none !important; opacity: 1 !important; transform: none !important; }
  #frame { width: ${fixture.width}px; box-sizing: border-box;
           background: var(--background); color: var(--foreground); }
</style>
</head>
<body><div id="frame">${html}</div></body>
</html>
`,
    'utf8',
  );
  console.error(`wrote ${out}  (${fixture.cases.length} cases, ${scheme})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
