'use client';

// Realtime voice input, browser half: the socket to /api/asr/<sessionId> and the
// little state machine that turns its events into text you can put on screen.
//
// THREE LAYERS OF TEXT, and keeping them apart is the whole design (see
// docs/realtime-voice-input-design.md):
//
//   partial  the sentence being spoken RIGHT NOW. Rewrites itself wholesale every
//            few hundred ms — "发" → "发 red hot" → "把Red Hole的隧道重启" — which
//            is exactly the effect worth showing, so it is passed through
//            unsmoothed.
//
//   tail     sentences the server has closed, joined.
//
//   polished each of those sentences again, corrected, replacing itself in place.
//            Arrives out of order (the jobs run concurrently), so segments are
//            addressed by id and the tail is rebuilt from the array — never
//            patched by string offset.
//
// All three end up in the composer's textarea: the words appear where you are
// going to send them, and the correction happens in place. They are reported
// separately rather than pre-joined for one reason — when the socket dies, only
// the CLOSED sentences may stay in the draft. The partial's audio is about to be
// re-transcribed by the batch fallback, and leaving it would deliver it twice.
//
// The socket carries the dashboard key as a `hermit-key.<token>` subprotocol,
// same as the terminal, and 401s for a scoped agent-share token — the caller
// treats that like any other failure and stays on press-and-hold.

import { getActiveKey } from '@/lib/keyring';
import { wsUrl } from '@/lib/api-base';
import {
  asrInitial, asrState, asrStep, type AsrModel, type DictationState,
} from '@/lib/asr-reduce';

export type { DictationState };

export interface AsrSocketEvents {
  /** The ASR task is live; audio is being transcribed. */
  onReady: () => void;
  /** Any of the three layers changed. */
  onState: (state: DictationState) => void;
  /** A sentence closed — safe to drop the capture layer's fallback buffer. */
  onSentence: () => void;
  /** stop() finished and everything landed. `tail` is final. */
  onDone: (tail: string) => void;
  /** The socket is unusable. Caller falls back to the batch route. */
  onFailure: (message: string) => void;
}

export interface AsrSocket {
  /** Queue 16 kHz mono PCM16 (buffered until the socket opens). */
  send: (pcm: Int16Array) => void;
  /** Ask the server to close the ASR task and flush; resolves via onDone. */
  stop: () => void;
  /** Drop it now, no flush, no events. */
  close: () => void;
}

/** Audio held while the socket is still opening — ~4 s, well past a normal connect. */
const PREOPEN_MAX_BYTES = 4 * 16_000 * 2;
/** stop() waits this long for the tail + corrections before giving up on them. */
const DONE_TIMEOUT_MS = 12_000;

export function openAsrSocket(sessionId: string, events: AsrSocketEvents): AsrSocket {
  // Follows the active keyring entry's deployment; see lib/api-base.ts.
  const url = wsUrl(`/api/asr/${encodeURIComponent(sessionId)}`);

  // Everything the frames say, and nothing about the socket — see
  // `lib/asr-reduce.ts`, which iOS runs the same table over.
  let model: AsrModel = asrInitial();
  let dead = false;
  let stopping = false;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let preopen: Int16Array[] = [];
  let preopenBytes = 0;

  const tail = () => asrState(model).tail;
  const emit = () => {
    if (dead) return;
    events.onState(asrState(model));
  };

  const sock = new WebSocket(url, [`hermit-key.${getActiveKey()}`]);
  sock.binaryType = 'arraybuffer';

  const fail = (message: string) => {
    if (dead) return;
    dead = true;
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    events.onFailure(message);
    try { sock.close(); } catch { /* already gone */ }
  };

  const settleDone = () => {
    if (dead) return;
    dead = true;
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    events.onDone(tail());
    try { sock.close(); } catch { /* already gone */ }
  };

  sock.onopen = () => {
    for (const c of preopen) {
      try { sock.send(c.buffer as ArrayBuffer); } catch { /* closing */ }
    }
    preopen = [];
    preopenBytes = 0;
  };

  sock.onmessage = (ev) => {
    const step = asrStep(model, String(ev.data));
    // A frame the reducer ignored — unknown type, unparseable, a correction for
    // a sentence that was never opened — hands the SAME object back, and
    // redrawing on it would write the identical tail into the draft again.
    const changed = step.model !== model;
    model = step.model;
    switch (step.effect.kind) {
      case 'ready':    events.onReady(); return;
      case 'sentence': emit(); events.onSentence(); return;
      case 'done':     emit(); settleDone(); return;
      case 'fail':     fail(step.effect.message); return;
      default:         if (changed) emit(); return;
    }
  };

  // A close we didn't ask for is a failure; one during stop() means the server
  // hung up before 'done' — the sentences already closed are still good, so that
  // is a clean finish, not a loss.
  sock.onclose = () => {
    if (dead) return;
    if (stopping) settleDone();
    else fail('connection closed');
  };
  sock.onerror = () => { if (!dead && !stopping) fail('connection error'); };

  return {
    send(pcm: Int16Array) {
      if (dead || stopping) return;
      if (sock.readyState === WebSocket.CONNECTING) {
        // The mic is already live while the socket handshakes; hold the first
        // syllables rather than clipping them.
        preopen.push(pcm);
        preopenBytes += pcm.byteLength;
        while (preopenBytes > PREOPEN_MAX_BYTES && preopen.length > 1) {
          preopenBytes -= preopen.shift()!.byteLength;
        }
        return;
      }
      if (sock.readyState !== WebSocket.OPEN) return;
      try { sock.send(pcm.buffer as ArrayBuffer); } catch { /* closing */ }
    },

    stop() {
      if (dead || stopping) return;
      stopping = true;
      if (sock.readyState !== WebSocket.OPEN) { settleDone(); return; }
      try { sock.send(JSON.stringify({ type: 'stop' })); } catch { settleDone(); return; }
      doneTimer = setTimeout(settleDone, DONE_TIMEOUT_MS);
    },

    close() {
      dead = true;
      if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
      try { sock.close(); } catch { /* already gone */ }
    },
  };
}
