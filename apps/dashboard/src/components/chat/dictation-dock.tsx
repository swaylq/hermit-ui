'use client';


// Realtime dictation, orchestrated. Owns the mic stream, the /api/asr socket, and
// the run's text; renders the DictationBar above the composer while a run is live
// and writes closed sentences straight into the draft.
//
// WHY IT IS ITS OWN COMPONENT AND NOT PART OF VoiceMic:
//
// · The bar belongs above the composer; the mic is a floating button that can be
//   dragged anywhere. Two different places on screen.
// · Partials arrive ~4×/second. If this state lived in SessionPane, the whole
//   chat pane would re-render at that rate for the duration of a dictation. Here
//   it re-renders one small bar, and SessionPane only hears about start/stop.
// · voice-mic.tsx's gesture logic is intricate and load-bearing (permission
//   timing on iOS, drag-vs-hold, push-to-talk); the less of it that has to move,
//   the better. The mic just calls toggle() on this.
//
// THE FALLBACK IS THE POINT OF HALF THIS FILE. A streaming socket is a more
// fragile thing than a POST — Caddy, a phone changing networks, DashScope
// throttling. So the capture layer keeps every sample since the last CLOSED
// sentence, and if the socket dies those seconds are POSTed to the batch
// /api/transcribe instead. The user is never told "say that again".


import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { authedFetch } from '@/lib/asst-fetch';
import { openAsrSocket, type AsrSocket } from '@/lib/asr-socket';
import { startStreaming, releaseWarmMic, type VoiceStream } from '@/lib/voice-capture';
import { readRealtimeStyle } from '@/lib/voice-style';
import { DictationBar, type DictationStatus } from '@/components/chat/dictation-bar';
import type { ComposerHandle } from '@/components/chat/composer';

/** A run this long is stopped on its own — a mic nobody closed is a bug, not a feature. */
const RUN_MAX_MS = 20 * 60_000;
/** Continuous silence that ends a run. Long enough to think, short enough not to eavesdrop. */
const SILENCE_STOP_MS = 30_000;
/** Below this the fallback clip is just room tone — not worth a round trip. */
const FALLBACK_MIN_BYTES = 44 + 16_000 * 2 * 0.4;

export interface DictationHandle {
  /** Start if idle, finish if running. What the mic button's tap does. */
  toggle: () => void;
  /** Discard the run and everything it dictated. */
  cancel: () => void;
  /** True while a run is live. */
  readonly active: boolean;
}

export const DictationDock = forwardRef<DictationHandle, {
  sessionId: string;
  composerRef: React.RefObject<ComposerHandle | null>;
  /** Told on start/stop so the mic button can change its face. */
  onActiveChange?: (active: boolean) => void;
  /** Transient message for the mic button to show (fallbacks, errors). */
  onNotice?: (text: string) => void;
}>(function DictationDock({ sessionId, composerRef, onActiveChange, onNotice }, ref) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<DictationStatus>('connecting');
  const [partial, setPartial] = useState('');
  const [pending, setPending] = useState(0);
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(0);

  const sockRef = useRef<AsrSocket | null>(null);
  const streamRef = useRef<VoiceStream | null>(null);
  const activeRef = useRef(false);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const setActiveBoth = useCallback((v: boolean) => {
    activeRef.current = v;
    setActive(v);
    onActiveChange?.(v);
  }, [onActiveChange]);

  // Tear down every moving part. Safe to call twice; that happens routinely
  // (a socket failure and the user hitting ✓ can race).
  const teardown = useCallback(() => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    if (clockTimer.current) { clearInterval(clockTimer.current); clockTimer.current = null; }
    streamRef.current?.cancel();
    streamRef.current = null;
    sockRef.current?.close();
    sockRef.current = null;
    composerRef.current?.endDictation();
    setActiveBoth(false);
    setPartial('');
    setPending(0);
    setLevel(0);
    setSilent(false);
    setStatus('connecting');
    releaseWarmMic();
  }, [composerRef, setActiveBoth]);

  // The socket died mid-run. Everything up to the last CLOSED sentence is already
  // in the draft; what is missing is the seconds since — which the capture layer
  // still has. Send those the old way rather than losing them.
  const fallbackToBatch = useCallback(async (why: string) => {
    if (!activeRef.current) return;
    setStatus('finishing');
    setHint('网络不稳，转成整段模式');
    const stream = streamRef.current;
    streamRef.current = null;
    sockRef.current?.close();
    sockRef.current = null;
    let text = '';
    try {
      const wav = stream ? await stream.stop() : null;
      if (wav && wav.size > FALLBACK_MIN_BYTES) {
        const fd = new FormData();
        fd.append('sessionId', sessionId);
        fd.append('wav', wav, 'voice.wav');
        fd.append('style', readRealtimeStyle());
        const r = await authedFetch('/api/transcribe', { method: 'POST', body: fd });
        if (r.ok) text = ((await r.json()) as { text?: string }).text?.trim() ?? '';
      }
    } catch {
      // The fallback failed too — the closed sentences in the draft are all we can offer.
    }
    if (text) composerRef.current?.appendText(text);
    onNotice?.(text ? '网络不稳，最后一段用整段模式补上了' : `听写中断：${why}`);
    setHint(null);
    teardown();
  }, [sessionId, composerRef, onNotice, teardown]);

  const stop = useCallback(() => {
    if (!activeRef.current || !sockRef.current) return;
    setStatus('finishing');
    // Capture first, socket second: no audio may arrive after 'stop'.
    streamRef.current?.cancel();
    streamRef.current = null;
    sockRef.current.stop();
  }, []);

  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    // Throw the run away, including what it put in the draft.
    composerRef.current?.setDictationTail('');
    teardown();
  }, [composerRef, teardown]);

  const armSilenceStop = useCallback((isSilent: boolean) => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    if (!isSilent) return;
    silenceTimer.current = setTimeout(() => {
      onNotice?.('没听到声音，已结束听写');
      stop();
    }, SILENCE_STOP_MS);
  }, [onNotice, stop]);

  const start = useCallback(() => {
    if (activeRef.current) return;
    setActiveBoth(true);
    setStatus('connecting');
    setPartial('');
    setPending(0);
    setHint(null);
    setStartedAt(Date.now());
    composerRef.current?.beginDictation();
    clockTimer.current = setInterval(() => setTick((n) => n + 1), 1000);

    // Socket first (its handshake overlaps the mic opening), but startStreaming
    // still runs inside this same synchronous gesture — on iOS a getUserMedia
    // that isn't in the gesture's own call stack loses its privilege.
    let sock: AsrSocket;
    try {
      sock = openAsrSocket(sessionId, readRealtimeStyle(), {
        onReady: () => setStatus('listening'),
        onState: (st) => {
          setPartial(st.partial);
          setPending(st.pending);
          composerRef.current?.setDictationTail(st.tail);
        },
        // A closed sentence is safely in the draft — the capture layer no longer
        // needs to keep its audio for the fallback.
        onSentence: () => streamRef.current?.mark(),
        onDone: (tail) => {
          composerRef.current?.setDictationTail(tail);
          teardown();
        },
        onFailure: (message) => { void fallbackToBatch(message); },
      });
    } catch (e) {
      // `new WebSocket` can throw outright (bad URL, blocked scheme). Without
      // this the bar would sit there forever with nothing behind it.
      onNotice?.('听写连接打不开');
      console.error('[dictation] socket open failed', e);
      teardown();
      return;
    }
    sockRef.current = sock;

    startStreaming({
      onChunk: (pcm) => sockRef.current?.send(pcm),
      onLevel: setLevel,
      onSilence: (s) => { setSilent(s); armSilenceStop(s); },
      maxMs: RUN_MAX_MS,
      onAutoStop: () => { onNotice?.('听写时长到上限，已结束'); stop(); },
    })
      .then((stream) => {
        // The run can be gone by the time the mic opens (cancelled, socket died).
        if (!activeRef.current) { stream.cancel(); return; }
        streamRef.current = stream;
      })
      .catch((e: unknown) => {
        const denied = (e as DOMException)?.name === 'NotAllowedError';
        onNotice?.(denied ? '麦克风被拒绝，去系统设置开启' : '麦克风不可用');
        teardown();
      });
  }, [sessionId, composerRef, setActiveBoth, teardown, fallbackToBatch, armSilenceStop, stop, onNotice]);

  useImperativeHandle(ref, () => ({
    toggle() { if (activeRef.current) stop(); else start(); },
    cancel,
    get active() { return activeRef.current; },
  }), [start, stop, cancel]);

  if (!active) return null;
  void tick; // the 1 Hz clock only exists to re-render the timer
  return (
    <DictationBar
      partial={partial}
      pending={pending}
      level={level}
      silent={silent}
      status={status}
      elapsedMs={startedAt ? Date.now() - startedAt : 0}
      hint={hint}
      onDone={stop}
      onCancel={cancel}
    />
  );
});
