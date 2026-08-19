'use client';

// Which transcription polish this device uses. Shared by the mic button (its
// settings popup writes it) and the dictation dock (the realtime socket sends it
// as a query param), so the two can't drift.
//
// `rewrite` = clean the dictation into fluent written text — the long-standing
// default for the batch, press-and-hold path.
// `minimal` = keep the user's own words, correct only mistakes.
//
// Realtime dictation defaults to `minimal` regardless (see REALTIME_DEFAULT):
// what it is for is the user's ORIGINAL sentence recognized accurately, and a
// per-sentence rewrite fights that. The stored value still wins when set.

export type MicStyle = 'rewrite' | 'minimal';

export const STYLE_KEY = 'hermit:voice-mic-style';
export const REALTIME_DEFAULT: MicStyle = 'minimal';

export function readMicStyle(): MicStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === 'minimal' ? 'minimal' : 'rewrite';
  } catch {
    return 'rewrite';
  }
}

/** The style the realtime socket should run with — the stored one, else minimal. */
export function readRealtimeStyle(): MicStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return v === 'minimal' || v === 'rewrite' ? v : REALTIME_DEFAULT;
  } catch {
    return REALTIME_DEFAULT;
  }
}

export function writeMicStyle(s: MicStyle): void {
  try { localStorage.setItem(STYLE_KEY, s); } catch { /* private mode */ }
}
