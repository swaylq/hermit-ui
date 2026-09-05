// What arrives on the /api/asr socket, turned into text you can put on screen —
// the whole of it, with no socket in sight.
//
// Split out of `asr-socket.ts` for one reason: the iOS shell has to reach the
// same three layers from the same frames, and the only honest way to check that
// is to run both implementations over one table
// (`apps/ios/tools/hold-fixture.sh`). What is left in `asr-socket.ts` is the
// WebSocket, the pre-open buffer and the timers; everything that decides what
// the words ARE is here.
//
// THREE LAYERS OF TEXT, and keeping them apart is the whole design (see
// docs/realtime-voice-input-design.md):
//
//   partial  the sentence being spoken RIGHT NOW. Rewrites itself wholesale.
//   tail     sentences the server has closed, joined.
//   polished each of those sentences again, corrected, replacing itself IN PLACE
//            — and arriving OUT OF ORDER, because the jobs run concurrently. So
//            segments are addressed by id and the tail is rebuilt from the
//            array, never patched by string offset. That is the one property in
//            here worth a table of its own.
//
// They are reported separately rather than pre-joined because when the socket
// dies, only the CLOSED sentences may stay in the draft: the partial's audio is
// about to be re-transcribed by the batch fallback, and leaving it would deliver
// it twice.

import { joinSegments } from '@/lib/dictation-text';

/** One closed sentence, and whether its correction is still outstanding. */
export interface AsrSeg { id: number; text: string; polishing: boolean }

/** Everything the reducer remembers. Plain data — copy it, compare it, print it. */
export interface AsrModel { segs: AsrSeg[]; partial: string }

export interface DictationState {
  /** Unstable sentence-in-progress. Render dim, outside the textarea. */
  partial: string;
  /** Closed sentences, joined — this is what belongs in the draft. */
  tail: string;
  /** Sentences still being corrected. */
  pending: number;
}

/**
 * What the caller must do about this frame, beyond redrawing.
 *
 * `sentence` — a sentence closed, so the capture layer's fallback buffer for it
 * can go. `done` — the server finished; `tail` is final. `fail` — the socket is
 * unusable and the caller falls back to the batch route. `ready` — the ASR task
 * is live.
 */
export type AsrEffect =
  | { kind: 'none' }
  | { kind: 'ready' }
  | { kind: 'sentence' }
  | { kind: 'done' }
  | { kind: 'fail'; message: string };

export function asrInitial(): AsrModel {
  return { segs: [], partial: '' };
}

export function asrState(m: AsrModel): DictationState {
  return {
    partial: m.partial,
    tail: joinSegments(m.segs.map((s) => s.text)),
    pending: m.segs.filter((s) => s.polishing).length,
  };
}

/** The message the server sends, as far as anything here cares. */
interface AsrFrame { type?: string; text?: string; segId?: number; message?: string; fatal?: boolean }

/**
 * Fold one frame in.
 *
 * Pure: `m` is not touched, a new model comes back. Anything unparseable, of an
 * unknown type, or addressed to a segment that was never opened is ignored —
 * this app ships continuously and the shell ships through TestFlight, so a
 * server that learned a frame before the client did is the normal case and must
 * degrade to silence rather than to a wrong transcript.
 *
 * A frame that says nothing new hands the SAME object back, so `next === m` is
 * an exact answer to "did anything change?" and not merely a cheap one. Callers
 * redraw on it; `asr-socket.ts` is one, and the iOS shell — where the model is a
 * value type and the comparison is structural — is the other. Keeping the two
 * meanings identical is what lets one table check both
 * (`apps/ios/tools/hold-fixture.sh`), and it is also why the guards below exist
 * at all: a repeated `partial` used to rewrite the draft with the text already
 * in it, ~36 times a second.
 */
export function asrStep(m: AsrModel, raw: string): { model: AsrModel; effect: AsrEffect } {
  let msg: AsrFrame;
  try { msg = JSON.parse(raw) as AsrFrame; } catch { return { model: m, effect: { kind: 'none' } }; }
  if (!msg || typeof msg !== 'object') return { model: m, effect: { kind: 'none' } };

  switch (msg.type) {
    case 'ready':
      return { model: m, effect: { kind: 'ready' } };

    case 'partial': {
      const next = msg.text ?? '';
      if (next === m.partial) return { model: m, effect: { kind: 'none' } };
      return { model: { segs: m.segs, partial: next }, effect: { kind: 'none' } };
    }

    case 'final': {
      // No id, no address — and a sentence we cannot address is one no
      // correction could ever replace, so it is dropped rather than appended.
      if (typeof msg.segId !== 'number') return { model: m, effect: { kind: 'none' } };
      return {
        model: {
          segs: [...m.segs, { id: msg.segId, text: msg.text ?? '', polishing: true }],
          partial: '',
        },
        effect: { kind: 'sentence' },
      };
    }

    case 'polished': {
      const i = m.segs.findIndex((s) => s.id === msg.segId);
      if (i === -1) return { model: m, effect: { kind: 'none' } };
      // `?? seg.text`: a correction that came back empty is not a correction to
      // an empty sentence, it is a correction that failed. Keep what we had.
      const text = msg.text ?? m.segs[i].text;
      if (text === m.segs[i].text && !m.segs[i].polishing) return { model: m, effect: { kind: 'none' } };
      const segs = m.segs.slice();
      segs[i] = { id: segs[i].id, text, polishing: false };
      return { model: { segs, partial: m.partial }, effect: { kind: 'none' } };
    }

    case 'done': {
      // Nothing is still being corrected by the time the server says done.
      const settled = m.partial === '' && !m.segs.some((s) => s.polishing);
      return {
        model: settled ? m : { segs: m.segs.map((s) => ({ ...s, polishing: false })), partial: '' },
        effect: { kind: 'done' },
      };
    }

    case 'error':
      return msg.fatal
        ? { model: m, effect: { kind: 'fail', message: msg.message ?? 'ASR failed' } }
        : { model: m, effect: { kind: 'none' } };

    default:
      return { model: m, effect: { kind: 'none' } };
  }
}
