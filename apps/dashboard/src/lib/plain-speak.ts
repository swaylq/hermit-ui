// Which replies get a 「说人话」 button, and how one is keyed in the cache.
//
// Pure and cheap: this runs on every assistant row that renders, so it may not
// allocate much and may not ask a model anything.
//
// The gate is deliberately about SIZE, not about how hard the text is. Whether
// a reply is confusing is exactly the judgement the reader is making when they
// tap the button — guessing it here would either hide the button on the reply
// they wanted or offer it on 「好的，已部署」. So the only thing refused is a
// message with nothing in it to unpack.

import { blockKey, detectLang, proseOnly } from '@/lib/translate-text';

/**
 * Below this a reply is an acknowledgement, not an explanation: 「好的」,
 * 「已部署，dashboard 返回 200」. Measured on PROSE only, so a two-line reply
 * that is mostly a file path does not qualify on the strength of the path.
 */
export const MIN_PLAIN_CHARS = 60;

/**
 * `plain1` — the version is part of the key on purpose. The rewrite depends on
 * the prompt in server/plain-speak.ts, so changing that prompt has to invalidate
 * what is cached on disk; bumping the tag does it without touching the database.
 */
const TAG = 'plain1';

export function plainKey(text: string): string {
  return blockKey(text, TAG);
}

/** Is there enough here to be worth rewriting? */
export function canPlainSpeak(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (detectLang(t) === 'none') return false;
  return proseOnly(t).replace(/\s+/g, '').length >= MIN_PLAIN_CHARS;
}
