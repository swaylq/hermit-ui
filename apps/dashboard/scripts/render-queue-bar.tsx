/**
 * Draw the REAL queue strip to a self-contained HTML file — no database, no dev
 * server, no browser — as the web half of the queue-bar pixel comparison whose
 * native half is `apps/ios/tools/render-queue.sh`.
 *
 *   pnpm --filter @hermit-ui/dashboard render:queue-bar <out.html> [dark|light]
 *
 * Same bargain as `render-session-rows.tsx`: this imports `QueueBar` from
 * `components/chat/composer.tsx` — the component the app ships — rather than
 * restating its markup, so a difference the diff finds is a difference between
 * the port and the app, not between two ports.
 *
 * Both sides read `apps/ios/tools/fixtures/queue-bar.json`. There is no clock to
 * pin here (unlike the session list, the strip draws nothing time-dependent),
 * which leaves exactly two things to hold still: the font, and the collapse.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { QueueBar } from '@/components/chat/composer';

// tsx compiles this to CJS (the package is not type:module), so __dirname is the
// portable one here — import.meta.url does not survive the transform.
const HERE = __dirname;
const FIXTURE = process.env.HERMIT_QUEUE_FIXTURE
  ?? resolve(HERE, '../../ios/tools/fixtures/queue-bar.json');
const GLOBALS = resolve(HERE, '../src/app/globals.css');

interface FixtureCase {
  why: string;
  items: string[];
  clearing: boolean;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  width: number;
  gap: number;
  cases: FixtureCase[];
};

const noop = () => {};

const html = renderToStaticMarkup(
  <>
    {fixture.cases.map((c, i) => (
      <div key={i} style={{ paddingBottom: `${fixture.gap}px` }}>
        <QueueBar
          items={c.items.map((text, j) => ({ id: `q${j}`, content: [{ type: 'text', text }] }))}
          onCancel={noop}
          onClear={noop}
          clearing={c.clearing}
        />
      </div>
    ))}
  </>,
);

const out = process.argv[2] ?? 'queue-bar.html';
const scheme = process.argv[3] === 'light' ? 'light' : 'dark';

async function main(): Promise<void> {
  const css = await postcss([tailwind()]).process(readFileSync(GLOBALS, 'utf8'), {
    from: GLOBALS,
  });

  writeFileSync(
    out,
    `<!doctype html>
<html class="${scheme === 'dark' ? 'dark' : ''}" style="color-scheme:${scheme}">
<head><meta charset="utf-8"><title>queue bar — ${scheme}</title>
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
  /* Collapse's OPEN state, forced.
     The strip is wrapped in <Collapse>, which mounts at grid-rows-[0fr]
     opacity-0 and flips on the next animation frame — a client effect that
     never runs in a static render, so without this the page is a blank band.
     The end state is the only one worth comparing: the native side draws no
     animation in a still frame either. */
  #frame .grid-rows-\\[0fr\\] { grid-template-rows: 1fr !important; }
  #frame .opacity-0 { opacity: 1 !important; }
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
