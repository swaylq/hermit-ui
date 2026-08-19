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
//            unsmoothed. It does NOT go in the textarea: it would fight the
//            caret, and a <textarea> can't style a substring to say "this is
//            still moving". It lives in the dictation bar, like an IME preedit
//            string. Unstable text does not enter the document.
//
//   tail     sentences the server has closed, joined. These DO go in the
//            textarea — the moment a sentence closes it is real text the user
//            could send.
//
//   polished each of those sentences again, corrected, replacing itself in place.
//            Arrives out of order (the jobs run concurrently), so segments are
//            addressed by id and the tail is rebuilt from the array — never
//            patched by string offset.
//
// The socket carries the dashboard key as a `hermit-key.<token>` subprotocol,
// same as the terminal, and 401s for a scoped agent-share token — the caller
// treats that like any other failure and stays on press-and-hold.

import { getActiveKey } from '@/lib/keyring';
import { joinSegments } from '@/lib/dictation-text';

export interface DictationState {
  /** Unstable sentence-in-progress. Render dim, outside the textarea. */
  partial: string;
  /** Closed sentences, joined — this is what belongs in the draft. */
  tail: string;
  /** Sentences still being corrected (drives the "…" in the bar). */
  pending: number;
}

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

interface Seg { id: number; text: string; polishing: boolean }

/** Audio held while the socket is still opening — ~4 s, well past a normal connect. */
const PREOPEN_MAX_BYTES = 4 * 16_000 * 2;
/** stop() waits this long for the tail + corrections before giving up on them. */
const DONE_TIMEOUT_MS = 12_000;

export function openAsrSocket(
  sessionId: string,
  style: 'minimal' | 'rewrite',
  events: AsrSocketEvents,
): AsrSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/api/asr/${encodeURIComponent(sessionId)}?style=${style}`;

  const segs: Seg[] = [];
  let partial = '';
  let dead = false;
  let stopping = false;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let preopen: Int16Array[] = [];
  let preopenBytes = 0;

  const tail = () => joinSegments(segs.map((s) => s.text));
  const emit = () => {
    if (dead) return;
    events.onState({ partial, tail: tail(), pending: segs.filter((s) => s.polishing).length });
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
    let msg: { type?: string; text?: string; segId?: number; message?: string; fatal?: boolean };
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    switch (msg.type) {
      case 'ready':
        events.onReady();
        return;
      case 'partial':
        partial = msg.text ?? '';
        emit();
        return;
      case 'final': {
        if (typeof msg.segId !== 'number') return;
        segs.push({ id: msg.segId, text: msg.text ?? '', polishing: true });
        partial = '';
        emit();
        events.onSentence();
        return;
      }
      case 'polished': {
        const seg = segs.find((s) => s.id === msg.segId);
        if (!seg) return;
        seg.text = msg.text ?? seg.text;
        seg.polishing = false;
        emit();
        return;
      }
      case 'done':
        // Nothing is still being corrected by the time the server says done.
        for (const s of segs) s.polishing = false;
        partial = '';
        emit();
        settleDone();
        return;
      case 'error':
        if (msg.fatal) fail(msg.message ?? 'ASR failed');
        return;
      default:
        return;
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
