'use client';

// How the live-preview layer moves under a finger, and when a drag has done
// enough to change its mind. One file because there are two hands on the same
// layer and they must feel identical:
//
//   · use-preview-swipe.ts — the finger is on the DASHBOARD's own document: the
//     pull out of the right edge, and a push-back that starts on the panel's
//     own chrome (its header, its padding).
//   · preview-panel.tsx — the finger is on the PREVIEWED PAGE, which fills the
//     layer on a phone and is another origin, so those touches never reach us.
//     The bridge injected into it describes the drag instead
//     (apps/gateway/src/preview/bridge.ts posts `swipe`), and the panel replays
//     it here.
//
// The numbers are shared with the nav drawer on the other edge
// (components/sidebar/use-drawer-swipe.ts), which is deliberate: one drawer
// vocabulary for the whole app.

/** Open/close travel. The panel's CSS transition uses it too — keep them equal. */
export const SLIDE_MS = 300;
/** px of travel before a touch is called horizontal rather than a scroll. */
export const SLOP = 10;
/** px/ms. Above this the flick's direction settles it, however far it got. */
export const FLICK = 0.3;
/** Otherwise: how much of the screen it has to cross. Asymmetric by
 *  construction — from closed you pull COMMIT in, from open you push COMMIT
 *  back out — so neither state sits one twitch away from flipping. */
export const COMMIT = 0.35;
/** A finger held still this long is not flicking any more, whatever it was
 *  doing before. Without this, parking the panel half-open and lifting is
 *  settled by a flick that ended a second ago. */
export const STALE_MS = 80;

/** Where the layer sits right now, 0 = flush open, `width` = fully off-screen. */
export function paintLayer(el: HTMLElement, tx: number): void {
  el.style.transition = 'none';
  el.style.transform = `translateX(${tx}px)`;
}

/**
 * Let go: hand the rest of the travel back to the class's transition, but
 * through the inline transform — clearing it here instead would snap the layer
 * to whatever the class says a frame before React agrees. The returned timer
 * clears the inline styles once the class has caught up.
 */
export function settleLayer(el: HTMLElement, toOpen: boolean, width: number): ReturnType<typeof setTimeout> {
  el.style.transition = '';
  el.style.transform = toOpen ? 'translateX(0)' : `translateX(${width}px)`;
  return setTimeout(() => {
    el.style.transition = '';
    el.style.transform = '';
  }, SLIDE_MS);
}

/** Would letting go right here keep the panel? Distance only — this is what the
 *  haptic tick promises mid-drag, so it must not consult velocity. */
export function willCommit(tx: number, width: number, wasOpen: boolean): boolean {
  const shown = 1 - tx / width; // 0 closed → 1 open
  return shown > (wasOpen ? 1 - COMMIT : COMMIT);
}

/** The same question at the moment the finger lifts, where a flick outranks distance. */
export function settlesOpen({
  tx,
  width,
  vx,
  wasOpen,
}: {
  tx: number;
  width: number;
  /** px/ms, negative = travelling left = opening. Zero it yourself if stale. */
  vx: number;
  wasOpen: boolean;
}): boolean {
  return Math.abs(vx) > FLICK ? vx < 0 : willCommit(tx, width, wasOpen);
}
