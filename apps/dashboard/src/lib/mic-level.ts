// How loud the mic is right now, published OUTSIDE React.
//
// The capture layer reports an RMS level about twelve times a second
// (voice-capture.ts, one call per 4096-sample block). That is a fine rate for a
// CSS transform and a terrible one for setState — the composer would re-render
// twelve times a second for the whole of a hold, which is the exact cost
// dictation-dock.tsx was split out to avoid.
//
// So the level travels through a module-level subscription, and its one reader
// (the press-and-hold overlay) writes it straight onto a DOM node as a custom
// property. Nothing re-renders; the green blob just breathes.

type Sub = (level: number) => void;

let current = 0;
const subs = new Set<Sub>();

/** 0…1 — roughly RMS × 5, clamped. Called from the capture layer. */
export function publishMicLevel(level: number) {
  current = level;
  for (const f of subs) f(level);
}

/** The run is over and nobody is listening — drop back to silence. */
export function resetMicLevel() {
  publishMicLevel(0);
}

/** Returns the unsubscribe. Fires once immediately with the level as it stands. */
export function subscribeMicLevel(f: Sub): () => void {
  subs.add(f);
  f(current);
  return () => { subs.delete(f); };
}
