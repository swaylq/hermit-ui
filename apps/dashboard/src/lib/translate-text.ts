// Deciding WHAT to translate, before anything is sent anywhere.
//
// Two jobs, both pure and both cheap enough to run on every streaming tick:
//
//   WHICH LANGUAGE — `detectLang`. Done locally, never by asking the model:
//     a round trip to decide whether a round trip is needed is the wrong shape,
//     and auto-translate has to make this call on every message that lands.
//
//   WHERE TO CUT — `splitBlocks`. A reply is translated one markdown block at a
//     time so the Chinese can accumulate while the English is still arriving.
//     Cutting anywhere else would either split a code fence in half or hand the
//     model a fragment with no sentence in it.
//
// The one thing both jobs care about is that source code is not prose. An
// English reply is mostly identifiers by character count — `REVEAL_LAG_MS`,
// `apps/dashboard/src/lib`, `pm2 restart hermit-ui-gateway` — and counting those
// as English would make a Chinese reply full of file paths look English. So
// every measurement here runs on `proseOnly`, and a block with no prose left in
// it is passed through untranslated rather than spent an API call on.


export type Lang = 'zh' | 'en' | 'none';

/** A markdown block, plus whether it has anything worth translating in it. */
export type SourceBlock = {
  /** The block as it appears in the source, trimmed of its trailing blank line. */
  text: string;
  /** False for a pure code fence, a bare URL, a horizontal rule — pass it through. */
  translatable: boolean;
};

// Below this a "message" is an acknowledgement, not prose: "OK", "Done.",
// "✅ deployed", "好的". Translating those adds a round trip and a flicker to
// say something the reader already understood. Measured on prose only, so a
// one-line reply that is 90% file path counts as short.
//
// One CJK character counts as one latin WORD (see detectLang), so the floor is
// in those same units and applies to both languages.
const MIN_PROSE_UNITS = 3;
// A second floor for the all-latin case: "not yet done" clears three words but
// is still an acknowledgement.
const MIN_PROSE_LETTERS = 12;

/**
 * Strip everything that is code rather than language: fenced blocks, inline
 * code, URLs, markdown link targets, and bare dotted/slashed identifiers.
 *
 * Deliberately aggressive. Over-stripping costs a little detection accuracy on
 * a message that was borderline anyway; under-stripping systematically misreads
 * technical Chinese as English, which is the failure that actually shows up.
 */
export function proseOnly(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // An unclosed fence — the tail of a reply still being written.
    .replace(/```[\s\S]*$/, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^ {4,}\S.*$/gm, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|sh|py|css|yml|yaml|toml|sql|env)\b/gi, ' ')
    .replace(/\b[\w-]+(?:\/[\w.-]+)+\b/g, ' ');
}

const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯豈-﫿]/g;
const LATIN_WORD_RE = /[A-Za-z]{2,}/g;
const LATIN_LETTER_RE = /[A-Za-z]/g;

function countOf(s: string, re: RegExp): number {
  return s.match(re)?.length ?? 0;
}

/**
 * Which language a message is written in, for the purpose of deciding whether
 * to translate it — not a general-purpose classifier.
 *
 * `none` means "nothing here to translate": too short, or all code. It is a
 * distinct answer from "I could not tell", because both callers treat it the
 * same way and there is no third branch to write.
 *
 * The comparison is CJK CHARACTERS against LATIN WORDS, not against latin
 * characters: one Chinese character carries about as much as one English word,
 * so counting characters on both sides would call every mixed sentence English.
 *
 * Symmetric, and a tie goes to `en`. An earlier version short-circuited on "any
 * three CJK characters means Chinese", which reads plausibly and is wrong in
 * the one case that matters: an English reply QUOTING the user's Chinese would
 * be called Chinese and silently skipped by auto-translate. A tie landing on
 * `en` is safe in both directions — translating something already Chinese
 * returns it verbatim (measured), and leaving a mixed outgoing message alone
 * sends exactly what was typed.
 */
export function detectLang(src: string): Lang {
  const prose = proseOnly(src);
  const cjk = countOf(prose, CJK_RE);
  const words = countOf(prose, LATIN_WORD_RE);
  const letters = countOf(prose, LATIN_LETTER_RE);
  if (cjk + words < MIN_PROSE_UNITS) return 'none';
  if (cjk === 0 && letters < MIN_PROSE_LETTERS) return 'none';
  return cjk > words ? 'zh' : 'en';
}

/** Whether a block contains prose at all — a pure code fence does not. */
export function hasProse(block: string): boolean {
  const prose = proseOnly(block);
  return countOf(prose, CJK_RE) > 0 || countOf(prose, LATIN_LETTER_RE) >= 2;
}

/**
 * Cut a message into the units that get translated separately.
 *
 * The boundary is a blank line — the same place markdown ends a block, and
 * therefore the same place `settleSplit` cuts the typewriter's reveal, which is
 * what lets a translated block slot in exactly where its English original was.
 * A fenced code block is never cut, however many blank lines are inside it.
 *
 * Blocks are returned trimmed of surrounding blank lines; rejoining them with
 * `\n\n` reproduces the message modulo runs of blank lines, which markdown
 * renders identically.
 */
export function splitBlocks(src: string): SourceBlock[] {
  const out: SourceBlock[] = [];
  const lines = src.split('\n');
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = buf.join('\n').replace(/^\n+|\n+$/g, '');
    buf = [];
    if (text) out.push({ text, translatable: hasProse(text) });
  };

  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      buf.push(line);
      // Closing marker must be at least as long as the opening one. Cutting
      // right here matters: without the flush, prose written straight after the
      // closing ``` stays welded to the code block, and the whole thing is then
      // classified as "no prose" and passed through untranslated.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
        flush();
      }
      continue;
    }
    if (marker) {
      // A fence opening mid-buffer starts its own block, so prose above it is
      // still translated separately and the code is passed through whole.
      flush();
      fence = marker;
      buf.push(line);
      continue;
    }
    if (line.trim() === '') flush();
    else buf.push(line);
  }
  flush();
  return out;
}

/** Rebuild a message from per-block results, in order. */
export function joinBlocks(parts: string[]): string {
  return parts.filter((p) => p !== '').join('\n\n');
}

/**
 * Should auto-translate fire on this message, given the target language?
 *
 * Strict on purpose: the manual button has no gate beyond "there is something
 * here", because the user asking for it IS the signal. Automatic translation
 * gets one wrong and the reader has no idea what the original said.
 */
export function shouldAutoTranslate(src: string, target: Lang): boolean {
  if (target !== 'zh' && target !== 'en') return false;
  const lang = detectLang(src);
  if (lang === 'none') return false;
  return lang !== target;
}

/**
 * Cache key for one translated block. The SOURCE TEXT is the key, never the
 * message id: the gateway retracts its placeholder row and lands the real one
 * under a different id mid-reply, and keying by id would throw away every
 * translation bought so far at exactly the moment the reader is watching.
 *
 * djb2 — short, stable across reloads, and collisions cost a re-translation
 * rather than a wrong answer, because the value is only ever a cache entry.
 *
 * `tag` is a plain string rather than a Lang because the same IndexedDB store
 * holds the 「说人话」 rewrites (lib/plain-speak.ts), and two features writing
 * one store must not be able to collide on a key. Every tag is a namespace.
 */
export function blockKey(text: string, tag: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${tag}:${text.length}:${(h >>> 0).toString(36)}`;
}

// ── Assembling what is on screen ─────────────────────────────────────────────

/** What `lookup` knows about one block: its translation, a refusal, or nothing yet. */
export type BlockState = string | 'failed' | undefined;

export type Assembly = {
  /** Blocks to ask for, in order, skipping anything already known. */
  wanted: Array<{ key: string; text: string }>;
  /** The contiguous run from the start that is in its final form. */
  shown: string;
  /** Everything after it, still as the sender wrote it. */
  rest: string;
  /** Nothing outstanding — `shown` is the whole message. */
  complete: boolean;
};

/**
 * How many blocks of a message are finished being written.
 *
 * While a reply streams, the last block is a fragment — half a sentence that
 * will grow. Translating it would buy a translation of that fragment, throw it
 * away when the block grows, and pay again. The exception is text ending in a
 * blank line: the block closed and the next has not started, so everything
 * present is complete.
 */
export function completeBlockCount(blocks: SourceBlock[], text: string, streaming: boolean): number {
  if (!streaming || /\n[ \t]*\n[ \t]*$/.test(text)) return blocks.length;
  return Math.max(0, blocks.length - 1);
}

/**
 * Turn per-block knowledge into the two strings the view renders.
 *
 * THE ORDERING RULE lives here: the walk stops at the first block that is not
 * resolved, so what is shown is always a contiguous run from the start. Filling
 * block 3 while block 2 is still out would make the paragraph under the
 * reader's eye change identity, and would hand the typewriter a string that
 * mutated behind its cursor.
 *
 * A block with no prose (a code fence, a horizontal rule) resolves instantly to
 * itself — it is never sent anywhere. A block the server refused resolves to its
 * original, so one bad paragraph does not stall the nine behind it.
 */
export function assemble(
  blocks: SourceBlock[],
  completeCount: number,
  target: Exclude<Lang, 'none'>,
  lookup: (key: string) => BlockState,
): Assembly {
  const wanted: Array<{ key: string; text: string }> = [];
  for (let i = 0; i < Math.min(completeCount, blocks.length); i++) {
    const b = blocks[i];
    if (!b.translatable) continue;
    const key = blockKey(b.text, target);
    if (lookup(key) === undefined) wanted.push({ key, text: b.text });
  }

  const parts: string[] = [];
  let i = 0;
  for (; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.translatable) {
      parts.push(b.text);
      continue;
    }
    if (i >= completeCount) break;
    const state = lookup(blockKey(b.text, target));
    if (state === undefined) break;
    parts.push(state === 'failed' ? b.text : state);
  }

  return {
    wanted,
    shown: joinBlocks(parts),
    rest: joinBlocks(blocks.slice(i).map((b) => b.text)),
    complete: i >= blocks.length,
  };
}
