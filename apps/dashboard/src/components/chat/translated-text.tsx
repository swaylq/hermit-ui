'use client';

// An assistant text block, shown in the reader's language.
//
// Drop-in for TypedText, and when translation is off or unavailable that is
// literally all it is — same component, same props, no behaviour change.
//
// THE ORDERING RULE. A reply is translated one markdown block at a time so the
// Chinese can start accumulating while the English is still being written. What
// gets rendered is the longest CONTIGUOUS run of blocks from the start that are
// ready — never block 3 while block 2 is still out. Out-of-order filling would
// make the paragraph under the reader's eye change identity mid-sentence, and
// the whole point of the reveal machinery is that text only ever grows.
//
// That rule is also what keeps the typewriter honest. useTypewriter assumes its
// input is append-only: it holds a fractional position into the string, and a
// string that mutates behind that position would either teleport or rewind. So
// the translated prefix is fed to TypedText (append-only by construction) and
// the not-yet-translated remainder is rendered SEPARATELY and dimmed, rather
// than concatenated into the same string. The remainder is deliberately plain
// and un-animated: it is a preview of what is being replaced, and animating it
// would put two typewriters in one paragraph.
//
// The last block of a reply that is still streaming is never sent. It is half a
// sentence; translating it would buy a translation of a fragment, throw it away
// when the block grows, and pay again.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { TypedText } from '@/components/chat/message-bits';
import { splitBlocks, assemble, completeBlockCount, shouldAutoTranslate, type BlockState, type Lang } from '@/lib/translate-text';
import {
  requestTranslations,
  getTranslation,
  translationFailed,
  translationUnavailable,
  subscribeTranslations,
  translationsVersion,
} from '@/lib/translate-store';

/** How much of the untranslated remainder to preview under the translation. */
const PREVIEW_CHARS = 240;

function zeroVersion(): number {
  return 0;
}

export function TranslatedText({
  text,
  typing,
  streamKey = '',
  sessionId,
  target,
  mode,
}: {
  text: string;
  typing: boolean;
  streamKey?: string;
  sessionId: string;
  /** Which language to show it in. */
  target: Exclude<Lang, 'none'>;
  /**
   * `auto` — translate only if this block is not already in `target`.
   * `on` / `off` — the reader pressed the button; their call beats the gate,
   * which is why `on` skips `shouldAutoTranslate` entirely.
   */
  mode: 'auto' | 'on' | 'off';
}) {
  // Re-render when any translation lands. Subscribing to a global counter
  // rather than per-key state keeps this to one subscription per visible block
  // and no bookkeeping when rows unmount mid-reply. The counter is also the
  // memo dependency below — the store is read imperatively, so without it the
  // assembled text would not be recomputed when an answer arrives.
  const version = useSyncExternalStore(subscribeTranslations, translationsVersion, zeroVersion);

  const on =
    mode !== 'off' &&
    !translationUnavailable() &&
    (mode === 'on' || shouldAutoTranslate(text, target));

  const blocks = useMemo(() => (on ? splitBlocks(text) : []), [on, text]);
  const completeCount = completeBlockCount(blocks, text, typing);

  // The store is read imperatively, so `version` is what tells this memo its
  // answers changed. The rule below is right that the body never reads it.
  const { wanted, shown, rest, complete } = useMemo(
    () => {
      const lookup = (key: string): BlockState =>
        getTranslation(key) ?? (translationFailed(key) ? 'failed' : undefined);
      return assemble(blocks, completeCount, target, lookup);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, completeCount, target, version],
  );

  useEffect(() => {
    if (!on || !wanted.length || !sessionId) return;
    requestTranslations(sessionId, wanted, target);
  }, [on, wanted, sessionId, target]);

  if (!on) return <TypedText text={text} typing={typing} streamKey={streamKey} />;

  // Nothing translated yet and nothing to show: keep the original on screen
  // rather than blanking the bubble while the first block is in flight.
  if (!shown) return <TypedText text={text} typing={typing} streamKey={streamKey} />;

  return (
    <div>
      <TypedText
        text={shown}
        // Only STARTS the reveal — useTypewriter latches. True while anything is
        // still outstanding, which is what makes a manually translated old
        // message type out instead of appearing all at once.
        typing={typing || !complete}
        // Its own reveal lane: the original and the translation are different
        // strings, and sharing a key would have each adopt the other's position
        // across the gateway's mid-reply row swap.
        streamKey={streamKey ? `${streamKey}:t` : ''}
      />
      {rest ? (
        <div
          aria-hidden
          className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground/45 leading-[1.65]"
        >
          {rest.length > PREVIEW_CHARS ? `${rest.slice(0, PREVIEW_CHARS)}…` : rest}
        </div>
      ) : null}
    </div>
  );
}
