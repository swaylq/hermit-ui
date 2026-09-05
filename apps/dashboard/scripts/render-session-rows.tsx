/**
 * Draw the REAL sidebar session row to a self-contained HTML file, with no
 * database, no dev server and no browser — the web half of the pixel comparison
 * whose native half is `apps/ios/tools/render-list.sh`.
 *
 *   pnpm --filter @hermit-ui/dashboard render:session-rows <out.html> [dark|light]
 *
 * The point is that this imports `components/sidebar/session-row.tsx` — the
 * component the app ships — instead of restating its markup. A harness with its
 * own copy of the row would compare the Swift port against a second port and
 * agree with itself forever. That is also why the row was lifted out of
 * recent-lists.tsx: that file reaches the trpc client and the Next router hooks
 * at import time, neither of which exists in a bare Node process.
 *
 * Two things are pinned so the comparison is about layout rather than about
 * clocks and fonts:
 *
 *   - `Date.now` is frozen to HERMIT_FIXTURE_NOW (or this process's start) and
 *     the native renderer is handed the same epoch, so both sides print the same
 *     "12s" / "2h" in the recency column. relTime and sessionStatusView both read
 *     the wall clock, and two screenshots a second apart would otherwise differ
 *     in a column nobody is trying to test.
 *   - the font variables are set to the system faces, because the real ones come
 *     from next/font at build time and the native side is drawing with the system
 *     face anyway. Comparing SF Pro against a missing webfont measures nothing.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { SessionRow } from '@/components/sidebar/session-row';
import { noteDashboardAnswer, CONTACT_GAP_MS } from '@/lib/dashboard-reach';

type SessionListItem = inferRouterOutputs<AppRouter>['chat']['listSessions'][number];

/**
 * The fields `tools/fixtures/session-rows.json` carries, as a slice of the real
 * router output. A `Pick` rather than a hand-written interface on purpose: rename
 * a column on the server and this stops compiling, which is the only way a
 * fixture stays honest about the shape it claims to be.
 */
type FixtureFields = Pick<
  SessionListItem,
  | 'id' | 'agentName' | 'title' | 'preview' | 'startedAt' | 'lastMessageAt'
  | 'lastReadAt' | 'closedAt' | 'hiddenAt' | 'hibernatedAt' | 'restartRequestedAt'
  | 'alive' | 'state' | 'snapshotAt' | 'backgroundBusy' | 'backgroundNote'
>;

interface FixtureRow {
  id: string;
  agentName: string;
  title: string | null;
  preview: string | null;
  startedAtAgo: number;
  lastMessageAtAgo: number | null;
  lastReadAtAgo: number | null;
  snapshotAtAgo: number | null;
  closedAtAgo: number | null;
  hiddenAtAgo: number | null;
  hibernatedAtAgo: number | null;
  restartRequestedAtAgo: number | null;
  alive: boolean | null;
  state: string | null;
  backgroundBusy: boolean | null;
  backgroundNote: string | null;
  active: boolean;
  pinned: boolean;
}

// tsx compiles this to CJS (the package is not type:module), so __dirname is the
// portable one here — import.meta.url does not survive the transform.
const HERE = __dirname;
const FIXTURE = process.env.HERMIT_ROWS_FIXTURE
  ?? resolve(HERE, '../../ios/tools/fixtures/session-rows.json');
const GLOBALS = resolve(HERE, '../src/app/globals.css');

const NOW = process.env.HERMIT_FIXTURE_NOW ? Number(process.env.HERMIT_FIXTURE_NOW) : Date.now();
// Freeze it before anything renders. sessionStatusView measures snapshot age and
// relTime measures recency, both against Date.now(); the native side takes the
// same epoch from HERMIT_FIXTURE_NOW.
Date.now = () => NOW;

// The third thing that has to be pinned, and the one that was NOT obvious: how
// well this browser can reach the dashboard. sessionStatusView only calls a row
// `stale` when the snapshot is old AND we have been in touch the whole time —
// a process that has never had an answer has "no basis to judge" and leaves the
// dot alone. A fresh Node process is exactly that process, so without this the
// gateway-went-quiet row rendered as amber/working on the web and grey/stale in
// Swift, whose StatusOptions.observedAt defaults to nil = now = healthy contact.
// That was the first real thing the comparison caught, and it was the harness.
//
// So: replay an hour of unbroken contact, one answer per 5s poll, which is the
// state a dashboard someone is actually looking at is in.
for (let t = NOW - 3_600_000; t <= NOW; t += CONTACT_GAP_MS / 3) noteDashboardAnswer(t);

function at(ago: number | null): Date | null {
  return ago === null ? null : new Date(NOW - ago * 1000);
}

function toRow(f: FixtureRow): SessionListItem {
  const fields: FixtureFields = {
    id: f.id,
    agentName: f.agentName,
    title: f.title,
    preview: f.preview,
    startedAt: new Date(NOW - f.startedAtAgo * 1000),
    lastMessageAt: at(f.lastMessageAtAgo),
    lastReadAt: at(f.lastReadAtAgo),
    closedAt: at(f.closedAtAgo),
    hiddenAt: at(f.hiddenAtAgo),
    hibernatedAt: at(f.hibernatedAtAgo),
    restartRequestedAt: at(f.restartRequestedAtAgo),
    // The router types these two as plain booleans; the fixture keeps them
    // nullable because SessionListItem.swift models every flag as "cannot say"
    // and row k is the row that exercises it. Handing the null straight to the
    // web row is deliberate and checked: it reads it as falsy and lands on the
    // same verdict the Swift port does ("ready" for a session nothing is known
    // about). Turning it into `false` here would invent a state the server never
    // sends AND make the two sides disagree.
    alive: f.alive as boolean,
    state: f.state,
    snapshotAt: at(f.snapshotAtAgo),
    backgroundBusy: f.backgroundBusy as boolean,
    backgroundNote: f.backgroundNote,
  };
  // The rest of the payload (groupId, the resolved backend, rssMb, contextTokens…)
  // is not declared in the fixture for the same reason SessionListItem.swift does
  // not declare it: the row does not draw it. The row never reads those fields, so
  // the widening is safe here and nowhere else.
  return fields as SessionListItem;
}

const rows: FixtureRow[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).rows;

// The row asks for these; none of them can fire in a static render.
const noop = () => {};
const noLongPress = () => ({}) as never;

const html = renderToStaticMarkup(
  <ul className="space-y-px">
    {rows.map((f) => (
      <SessionRow
        key={f.id}
        session={toRow(f)}
        active={f.active}
        liveAt={null}
        live={null}
        pinned={f.pinned}
        onPrefetch={noop}
        onSelect={noop}
        onOpenMenu={noop}
        longPress={noLongPress}
      />
    ))}
  </ul>,
);

const out = process.argv[2] ?? 'session-rows.html';
const scheme = process.argv[3] === 'light' ? 'light' : 'dark';

async function main(): Promise<void> {
  const css = await postcss([tailwind()]).process(readFileSync(GLOBALS, 'utf8'), {
    from: GLOBALS,
  });

  // 320 wide with 8px of side padding and 6px top and bottom: the frame
  // tools/render-list.swift draws the native list into, to the pixel.
  writeFileSync(
    out,
    `<!doctype html>
<html class="${scheme === 'dark' ? 'dark' : ''}" style="color-scheme:${scheme}">
<head><meta charset="utf-8"><title>session rows — ${scheme}</title>
<style>${css.css}</style>
<style>
  :root { --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
          --font-geist-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; }
  html, body { margin: 0; padding: 0; }
  /* The window is a whole number of points and the eleven rows are not, so a
     sliver of body shows under the frame; paint it the same colour the native
     canvas paints it, or the differ reports a band nobody is testing. */
  body { font-family: var(--font-sans); -webkit-font-smoothing: antialiased;
         background: var(--sidebar); }
  /* The comparison is of a still frame; a pulsing dot would diff against itself. */
  .animate-pulse { animation: none !important; }
  #frame { width: 320px; box-sizing: border-box; padding: 6px 8px;
           background: var(--sidebar); color: var(--sidebar-foreground); }
</style>
</head>
<body><div id="frame">${html}</div></body>
</html>
`,
    'utf8',
  );
  console.error(`wrote ${out}  (${rows.length} rows, ${scheme}, now=${NOW})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
