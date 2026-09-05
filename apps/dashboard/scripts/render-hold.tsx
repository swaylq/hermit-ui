/**
 * Draw the REAL press-and-hold overlay to a self-contained HTML file — no
 * database, no dev server, no browser — as the web half of the comparison whose
 * native half is `apps/ios/tools/render-hold.sh`.
 *
 *   pnpm --filter @hermit-ui/dashboard render:hold <out.html>
 *
 * Same bargain as `render-attachments.tsx`: this imports `HoldToTalkFace` from
 * `components/chat/hold-to-talk.tsx` — the component the dashboard ships —
 * rather than restating its markup, so a difference the diff finds is a
 * difference between the port and the app.
 *
 * Both sides read `apps/ios/tools/fixtures/hold-states.json`. Each case is a
 * whole SCREEN (393×852), so they are laid out side by side in fixed-size
 * frames rather than stacked, and the overlay's `fixed inset-0` is contained by
 * giving each frame a `transform` — which is exactly the trap the real overlay
 * portals to `<body>` to avoid, and exactly what is wanted here.
 *
 * Over the app's own LIGHT background on both sides — not over black, and not
 * over a chat. Not a chat because a timeline behind it would be comparing the
 * timeline twice; not black because a black scrim over black is invisible, and
 * the first version of this harness did exactly that: it reported 1.65% while
 * the native overlay was two thirds as dark as the web's.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { HoldToTalkFace } from '@/components/chat/hold-to-talk';
import type { HoldPhase, HoldZone } from '@/components/chat/hold-core';

const HERE = __dirname;
const FIXTURE = process.env.HERMIT_HOLD_FIXTURE
  ?? resolve(HERE, '../../ios/tools/fixtures/hold-states.json');
const GLOBALS = resolve(HERE, '../src/app/globals.css');

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  width: number;
  height: number;
  gap: number;
  cases: { why: string; zone: HoldZone; phase: HoldPhase; text: string }[];
};

const html = renderToStaticMarkup(
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: `${fixture.gap}px` }}>
    {fixture.cases.map((c, i) => (
      <div
        key={i}
        className="frame"
        style={{
          width: `${fixture.width}px`,
          height: `${fixture.height}px`,
          position: 'relative',
          overflow: 'hidden',
          background: 'var(--background)',
          // A containing block for the overlay's `position: fixed`, which is the
          // whole point: eight screens on one canvas.
          transform: 'translateZ(0)',
        }}
      >
        <HoldToTalkFace zone={c.zone} phase={c.phase} text={c.text} show live />
      </div>
    ))}
  </div>,
);

const out = process.argv[2] ?? 'hold.html';

async function main(): Promise<void> {
  const css = await postcss([tailwind()]).process(readFileSync(GLOBALS, 'utf8'), { from: GLOBALS });
  writeFileSync(
    out,
    `<!doctype html>
<html style="color-scheme:light">
<head><meta charset="utf-8"><title>hold-to-talk</title>
<style>${css.css}</style>
<style>
  /* The real faces come from next/font at build time and the native side draws
     with the system face anyway; comparing SF Pro against a missing webfont
     measures nothing. */
  :root { --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  html, body { margin: 0; padding: 0; background: var(--background); }
  body { font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
  /* \`--lv\` is written by the mic-level subscriber at runtime; a still has no
     microphone, and the native still draws the resting level too. */
  .frame { --lv: 0; }
  /* The spinner beside 正在发送 turns. A still has to pick a moment, and both
     sides pick the one it starts from. */
  .frame .animate-spin { animation: none !important; }
</style>
</head>
<body>${html}</body>
</html>
`,
    'utf8',
  );
  console.log(`wrote ${out} — ${fixture.cases.length} screens`);
}

void main();
