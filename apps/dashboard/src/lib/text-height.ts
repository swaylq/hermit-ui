// How tall a row's prose will be, computed BEFORE the row is rendered.
//
// The windowed timeline has to know the height of rows it has never mounted:
// they add up to the spacer above the viewport, which is what puts the scrollbar
// in the right place and what the reading-position correction is measured
// against. Until now every one of those rows got the same number — the running
// mean of whatever had been measured (see estimateFrom in timeline-window.ts) —
// so "好的。" and a two-thousand-character answer with a code block were guessed
// at the same height, and the whole error came back as a scroll correction the
// moment either one mounted.
//
// pretext (@chenglou/pretext) measures text the way the browser lays it out —
// Intl.Segmenter for the segmentation, canvas measureText for the widths, using
// the browser's own font engine as ground truth — and then wraps lines as pure
// arithmetic, with no DOM and therefore no reflow. Measured here on this app's
// content, 112 of 112 cases matched getBoundingClientRect exactly (0.5px
// tolerance) across WebKit and Chrome, over Chinese, English, mixed, emoji and
// long-URL samples, and over four font stacks including `Geist` — which matters,
// because Geist ships no CJK glyphs and this UI is mostly Chinese, so canvas has
// to pick the same fallback font the DOM picks. It does.
//
// WHAT THIS DOES NOT KNOW. It measures prose, and a row is more than prose:
// bubble padding, the gaps between markdown blocks, an avatar, a timestamp, a
// code block that may or may not grow a horizontal scrollbar, an image, a run
// capsule. So the number here is never used as a height on its own — it is fed
// to fitProseHeights (timeline-window.ts), which learns the relationship between
// this number and real measured heights from the rows that HAVE been on screen.
// Everything this file cannot see is absorbed there, which also means a CSS
// change re-fits itself instead of silently rotting a hand-written constant.

import { splitBlocks } from '@/lib/translate-text';

type PretextModule = {
  prepare: (text: string, font: string, opts?: Record<string, unknown>) => unknown;
  layout: (prepared: unknown, width: number, lineHeight: number) => { height: number; lineCount: number };
};

let lib: PretextModule | null = null;
let loadStarted = false;

/**
 * Pull the library in. Deliberately not awaited by anything on the render path:
 * until it lands, `proseHeight` returns 0 and every caller falls back to the
 * estimator that was there before, which is the same behaviour as a browser too
 * old for Intl.Segmenter.
 */
export function loadTextHeight(): void {
  if (loadStarted || typeof window === 'undefined') return;
  loadStarted = true;
  void import('@chenglou/pretext')
    .then((m) => {
      // Intl.Segmenter and canvas text measurement are both hard requirements.
      if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) return;
      lib = m as unknown as PretextModule;
    })
    .catch(() => {
      /* offline, blocked, or an engine it does not support — stay on the mean */
    });
}

export function textHeightReady(): boolean {
  return lib !== null;
}

/** Test seam. */
export function __setTextHeightLib(mock: PretextModule | null): void {
  lib = mock;
}

// Markdown source is not what gets laid out. `**root cause**` renders ten
// characters, not fourteen, and `[the note](https://…/a/very/long/url)` renders
// eight. Measuring the source would overestimate every emphasised or linked
// line, and the error scales with how much markdown the writer used — exactly
// the kind of bias a single fitted slope cannot absorb, because it varies per
// row rather than across the corpus.
//
// Only the inline marks are worth removing. Block-level marks (`#`, `>`, `- `)
// change the block's own geometry rather than its text width, and that part is
// left to the fit.
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const CODE_SPAN = /`([^`]*)`/g;
const EMPHASIS = /(\*\*|__|\*|_)/g;

export function stripInline(md: string): string {
  return md
    .replace(IMAGE, '')
    .replace(LINK, '$1')
    .replace(CODE_SPAN, '$1')
    .replace(EMPHASIS, '');
}

export type ProseMetrics = {
  /** Laid-out height of every prose block in this row, in px. */
  height: number;
  /** How many blocks that was. Rows with none get no prediction at all. */
  blocks: number;
};

/**
 * The prose in `text`, laid out at `width`.
 *
 * Blocks that are not prose — a bare code fence, a lone URL, a horizontal rule —
 * are skipped rather than guessed at: splitBlocks already tells prose from the
 * rest (it has to, to decide what is worth translating), and a fenced block's
 * height depends on things this cannot see anyway.
 *
 * Returns `blocks: 0` when there is nothing to go on, which is the caller's
 * signal to fall back rather than to believe a zero.
 */
export function proseHeight(
  text: string,
  o: { font: string; lineHeight: number; width: number },
): ProseMetrics {
  if (!lib || !text || o.width <= 0 || o.lineHeight <= 0) return { height: 0, blocks: 0 };
  let height = 0;
  let blocks = 0;
  try {
    for (const b of splitBlocks(text)) {
      if (!b.translatable) continue;
      const body = stripInline(b.text).trim();
      if (!body) continue;
      const laid = lib.layout(lib.prepare(body, o.font), o.width, o.lineHeight);
      // An empty layout is zero lines; the browser still gives a block one.
      height += Math.max(1, laid.lineCount) * o.lineHeight;
      blocks++;
    }
  } catch {
    // A font string canvas will not parse, or a text the segmenter chokes on.
    // One bad row must not take the estimator down for the whole session.
    return { height: 0, blocks: 0 };
  }
  return { height, blocks };
}

/**
 * The canvas font string for an element, in the shorthand pretext wants.
 *
 * Read from getComputedStyle rather than assumed, so it follows the theme, the
 * user's own font-size setting, and whatever next/font named the family this
 * build — all three have moved before.
 */
export function fontOf(el: Element): { font: string; lineHeight: number } {
  const cs = getComputedStyle(el);
  const size = cs.fontSize || '16px';
  const family = cs.fontFamily || 'sans-serif';
  const weight = cs.fontWeight && cs.fontWeight !== '400' ? `${cs.fontWeight} ` : '';
  const parsed = Number.parseFloat(cs.lineHeight);
  // `line-height: normal` has no px value; ~1.5 is what this app's prose uses.
  const lineHeight = Number.isFinite(parsed) ? parsed : Number.parseFloat(size) * 1.5;
  return { font: `${weight}${size} ${family}`, lineHeight };
}
