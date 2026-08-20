// The two pure string decisions realtime dictation rests on. Pulled out of the
// components that use them (asr-socket joins, composer rewrites) because these
// are exactly the parts that go quietly wrong — a welded-together word, a
// dictation run silently eating text the user typed while it was running — and
// silent wrongness is what tests are for.

/**
 * Join closed sentences into the text that belongs in the draft.
 *
 * ASR punctuates its own output ("…重启一下。"), so sentences abut directly and a
 * space between them would be wrong in Chinese. The exception is the seam where
 * one sentence ends and the next begins with Latin word characters — "…restart"
 * + "then check…" welded together is a different word.
 */
export function joinSegments(texts: string[]): string {
  let out = '';
  for (const t of texts) {
    if (!t) continue;
    if (out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(t)) out += ' ';
    out += t;
  }
  return out;
}

/**
 * A dictation run's claim on the draft: everything after `base` is ours to
 * rewrite. `base: null` means the run hasn't put a character in yet, so the base
 * is still whatever the user will have typed by the time the first sentence
 * lands — which is why it is resolved lazily instead of at run start.
 */
export interface DictationClaim {
  base: string | null;
  /**
   * Exactly what was last written, which is not always `base + tail`: an empty
   * tail renders as `base` with its separator trimmed, so cancelling a run gives
   * back the user's own text rather than their text plus a stray space. Storing
   * what we rendered — rather than recomputing it — is what keeps the
   * "did the user edit this?" check honest.
   */
  rendered: string;
}

export function newClaim(): DictationClaim {
  return { base: null, rendered: '' };
}

/**
 * Fold a new tail into the current draft.
 *
 * The invariant is `draft === base + tail`. When it doesn't hold, the user typed
 * or edited while dictating — and THEIR TEXT WINS: the draft as it stands becomes
 * the new base and the tail grows after it, rather than overwriting what they
 * just wrote. That is the whole reason the tail is rewritten wholesale instead of
 * patched by offset: corrections come back out of order, so there is no offset
 * arithmetic to get wrong, and one string comparison catches every interference.
 *
 * Pure: returns the next draft and the next claim, mutating nothing.
 */
export function foldTail(
  claim: DictationClaim,
  draft: string,
  tail: string,
): { draft: string; claim: DictationClaim } {
  // Nothing dictated yet and nothing to dictate — leave the draft alone rather
  // than materialising a separator the user never asked for.
  if (claim.base === null && !tail) return { draft, claim };

  const intact = claim.base !== null && draft === claim.rendered;
  let base = claim.base;
  if (!intact) {
    const head = draft.trimEnd();
    base = head ? `${head} ` : '';
  }
  const rendered = tail ? base! + tail : base!.trimEnd();
  return { draft: rendered, claim: { base: base!, rendered } };
}
