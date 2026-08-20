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

/**
 * Swap a finished run's whole tail for the corrected passage — the end-of-run
 * refine landing.
 *
 * Deliberately NOT foldTail. foldTail rebases when the draft has moved under it,
 * because the tail it folds is still GROWING: words that arrive after the user
 * typed something must land after what they typed, not on top of it. A refine is
 * the opposite shape — it replaces text that is already on the screen — so
 * "the draft moved" cannot mean "append after it". That would leave the passage
 * in the draft twice. It means this correction is stale, and stale corrections
 * are dropped: the user's draft is the newer of the two.
 *
 * Also dropped when the run never put anything in the draft (`base === null`),
 * which is the cancelled/empty case — there is no tail to replace.
 */
export function replaceTail(
  claim: DictationClaim,
  draft: string,
  tail: string,
): { draft: string; claim: DictationClaim; applied: boolean } {
  if (claim.base === null || draft !== claim.rendered) return { draft, claim, applied: false };
  const rendered = tail ? claim.base + tail : claim.base.trimEnd();
  return { draft: rendered, claim: { base: claim.base, rendered }, applied: true };
}

// Both counts are in characters, and the unit that matters is the CJK one — a
// dictated Chinese sentence runs 8–15 characters, so 16 is "more than one thing
// was said" and 36 is a paragraph's worth. (Latin text of the same length says
// less, which errs toward refining a short English utterance. That costs one
// ~300 ms call; the other error costs the user their meaning.)
/** Below this there is no passage, only an utterance — and nothing to stitch. */
const REFINE_MIN_CHARS = 16;
/** …unless it is long enough that one sentence can be mangled on its own. */
const REFINE_LONG_CHARS = 36;
/** What ASR puts between two pauses. Each one is a place the meaning may be cut. */
const SENTENCE_BREAK = /[。．.！!？?；;\n]/g;

/**
 * Is this passage worth a whole-passage correction pass?
 *
 * The pass costs a round trip and a visible half-second at the end of a run, so
 * it should not run on 「继续」. What it is FOR is the seam between sentences —
 * so the trigger is that there were seams: two or more closed sentences, which
 * means per-sentence polish ran at least twice with no idea of the other. One
 * long sentence qualifies too (it can be mangled internally), a short one never.
 */
export function worthRefining(passage: string): boolean {
  const text = passage.trim();
  if (text.length < REFINE_MIN_CHARS) return false;
  if (text.length >= REFINE_LONG_CHARS) return true;
  return (text.match(SENTENCE_BREAK) ?? []).length >= 2;
}
