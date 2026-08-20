'use client';

// Realtime dictation, orchestrated. Owns the mic stream, the /api/asr socket, the
// reveal animation, and the run's text; renders the DictationBar above the
// composer while a run is live and writes the words into the draft.
//
// WHY IT IS ITS OWN COMPONENT AND NOT PART OF VoiceMic:
//
// · The bar belongs above the composer; the mic is a floating button that can be
//   dragged anywhere. Two different places on screen.
// · The text changes ~36×/second while the reveal animation runs. If this state
//   lived in SessionPane the whole chat pane would re-render at that rate; here
//   only the composer's own draft state moves, which is what it was designed for.
// · voice-mic.tsx is gesture code — permission timing on iOS, drag-vs-hold,
//   push-to-talk — and gestures and pipelines are better kept apart.
//
// TWO WAYS IN, and the bar has to know which, because the way OUT differs:
//   'hold' — the mic is still held down. Release finishes, sliding up cancels.
//   'tap'  — hands-free. Tapping the mic again finishes it.
// Either way the mic button stays on screen: a button that vanishes mid-press
// never delivers its pointerup, and a held run would never end. The bar carries
// its own ✓ and ✕ regardless, because the mic can be hidden behind the iOS
// keyboard while the bar cannot — see dictation-bar.tsx.
//
// DEGRADING, NOT FAILING. There is no separate "old mode" any more, so this has
// to cover everyone the socket can't serve: no DASHSCOPE_API_KEY, a scoped
// agent-share token (the socket is machine-key only), a dropped connection
// mid-sentence. In every one of those the run KEEPS GOING and quietly becomes a
// batch recording — the capture layer has held every sample since the last
// closed sentence, so on release those seconds go to /api/transcribe and the
// words arrive a moment later instead of live. Nobody is ever told to say it
// again.

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
import { joinSegments, worthRefining } from '@/lib/dictation-text';
import { typeFrame, TYPE_TICK_MS } from '@/lib/typewriter';
import { DictationBar, type DictationStatus } from '@/components/chat/dictation-bar';
import type { ComposerHandle } from '@/components/chat/composer';

/** How a run was started — decides how it ends, and what the bar shows. */
export type DictationSource = 'hold' | 'tap';

/** A run this long is stopped on its own — a mic nobody closed is a bug. */
const RUN_MAX_MS = 20 * 60_000;
/** Continuous silence that ends a run. Long enough to think, short enough not to eavesdrop. */
const SILENCE_STOP_MS = 30_000;
/** Below this a recording is room tone, not speech — not worth a round trip. */
const BATCH_MIN_BYTES = 44 + 16_000 * 2 * 0.4;
/**
 * How long the end-of-run refine may hold the bar open before we give up on it.
 * Measured at 0.3–1.0 s on live qwen-flash across passage sizes; 6 s is "the
 * network ate it", and giving up costs nothing — the words are already in the
 * draft, uncorrected but complete.
 */
const REFINE_TIMEOUT_MS = 6_000;

// The server said it has no model to refine with. Like realtimeUnavailable, that
// answer will not change on this page load, so later runs skip the request.
let refineUnavailable = false;

// The server said realtime isn't configured at all. That answer won't change on
// this page load, so later runs skip the socket and record straight away rather
// than opening a connection that will only be refused again.
let realtimeUnavailable = false;

export interface DictationHandle {
  /**
   * Start a run of this kind. If one is ALREADY live this re-labels it instead:
   * every press opens the run as 'hold' (so the mic is live from pointerdown and
   * no syllable is lost), and a quick release re-labels it hands-free rather
   * than restarting anything.
   */
  start: (source: DictationSource) => void;
  /** Finish: flush the transcript into the draft and close. */
  stop: () => void;
  /** Throw the run away, including what it put in the draft. */
  cancel: () => void;
  readonly active: boolean;
}

export const DictationDock = forwardRef<DictationHandle, {
  sessionId: string;
  composerRef: React.RefObject<ComposerHandle | null>;
  /** Told on start/stop so the mic can hide itself for a hands-free run. */
  onActiveChange?: (active: boolean, source: DictationSource | null) => void;
  /** Transient message for the composer's notice line. */
  onNotice?: (text: string) => void;
  /** The held finger has slid up far enough that releasing will cancel. */
  cancelArmed?: boolean;
}>(function DictationDock({ sessionId, composerRef, onActiveChange, onNotice, cancelArmed = false }, ref) {
  const [active, setActive] = useState(false);
  const [source, setSource] = useState<DictationSource>('tap');
  const [status, setStatus] = useState<DictationStatus>('connecting');
  // start() runs inside a pointerdown and has to know the phase synchronously.
  const statusRef = useRef<DictationStatus>('connecting');
  const setPhase = useCallback((s: DictationStatus) => { statusRef.current = s; setStatus(s); }, []);
  const [pending, setPending] = useState(0);
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [, tick] = useState(0);

  const sockRef = useRef<AsrSocket | null>(null);
  const streamRef = useRef<VoiceStream | null>(null);
  const activeRef = useRef(false);
  // 'stream' = live transcript; 'batch' = the socket is gone, we are just
  // recording and will transcribe the whole thing on release.
  const modeRef = useRef<'stream' | 'batch'>('stream');
  // Closed sentences only, without the partial riding on the end — what may stay
  // in the draft when a run ends badly, since the partial's audio has not been
  // transcribed by anything that finished.
  const committedRef = useRef('');
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Which run we are on. The end-of-run pass outlives the words it corrects by
  // up to a few hundred ms, so everything it does afterwards — writing to the
  // draft, tearing the run down — is checked against this first. Without it, a
  // second run started in that window gets its tail overwritten by the first
  // run's passage, and then torn down by the first run's teardown.
  const runIdRef = useRef(0);
  const refineAbort = useRef<AbortController | null>(null);

  // ── the reveal animation ──────────────────────────────────────────────────
  // `target` is what the transcript says; `shown` is how much of it has been
  // typed out. See lib/typewriter.ts for why some changes animate and some snap.
  const targetRef = useRef('');
  const shownRef = useRef('');
  const typeTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const paint = useCallback((text: string) => {
    shownRef.current = text;
    composerRef.current?.setDictationTail(text);
  }, [composerRef]);

  const stopTyping = useCallback(() => {
    if (typeTimer.current) { clearInterval(typeTimer.current); typeTimer.current = null; }
  }, []);

  /** Put `text` on screen over the next few frames. */
  const typeTo = useCallback((text: string) => {
    targetRef.current = text;
    if (typeTimer.current) return;
    typeTimer.current = setInterval(() => {
      const next = typeFrame(shownRef.current, targetRef.current);
      if (next === shownRef.current) { stopTyping(); return; }
      paint(next);
    }, TYPE_TICK_MS);
  }, [paint, stopTyping]);

  /** Land on `text` now — no animation. For ending a run, where waiting is silly. */
  const settleTo = useCallback((text: string) => {
    stopTyping();
    targetRef.current = text;
    paint(text);
  }, [paint, stopTyping]);

  const setActiveBoth = useCallback((v: boolean, s: DictationSource | null) => {
    activeRef.current = v;
    setActive(v);
    onActiveChange?.(v, s);
  }, [onActiveChange]);

  // Tear down every moving part. Safe to call twice; that happens routinely
  // (a socket failure and the user releasing can race).
  const teardown = useCallback(() => {
    refineAbort.current?.abort();
    refineAbort.current = null;
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    if (clockTimer.current) { clearInterval(clockTimer.current); clockTimer.current = null; }
    stopTyping();
    streamRef.current?.cancel();
    streamRef.current = null;
    sockRef.current?.close();
    sockRef.current = null;
    composerRef.current?.endDictation();
    setActiveBoth(false, null);
    setPending(0);
    setLevel(0);
    setSilent(false);
    setPhase('connecting');
    setHint(null);
    releaseWarmMic();
  }, [composerRef, setActiveBoth, stopTyping, setPhase]);

  /** Transcribe whatever the capture layer is holding, the batch way. */
  const flushBatch = useCallback(async (): Promise<string> => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (!stream) return '';
    try {
      const wav = await stream.stop();
      if (wav.size <= BATCH_MIN_BYTES) return '';
      const fd = new FormData();
      fd.append('sessionId', sessionId);
      fd.append('wav', wav, 'voice.wav');
      fd.append('style', readRealtimeStyle());
      const r = await authedFetch('/api/transcribe', { method: 'POST', body: fd });
      if (!r.ok) return '';
      return ((await r.json()) as { text?: string }).text?.trim() ?? '';
    } catch {
      return '';
    }
  }, [sessionId]);

  // The socket is unusable. Do NOT end the run — keep the mic open and finish as
  // a recording. The only thing that has to go is the partial: its audio is
  // still in the capture buffer and is about to be transcribed again.
  const degradeToBatch = useCallback((why: string, fatal: boolean) => {
    if (!activeRef.current || modeRef.current === 'batch') return;
    modeRef.current = 'batch';
    if (fatal) realtimeUnavailable = true;
    sockRef.current?.close();
    sockRef.current = null;
    settleTo(committedRef.current);
    setPhase('offline');
    setPending(0);
    console.warn('[dictation] realtime unavailable, recording instead —', why);
  }, [settleTo, setPhase]);

  // ── the end-of-run pass ───────────────────────────────────────────────────
  // Everything up to here has been corrected one sentence at a time, each one
  // blind to the others (asr-stream.ts) — which is what makes dictation feel
  // instant and what leaves a halting speaker with a draft cut into fragments.
  // Now that the passage is complete, it goes back once as a whole. See
  // server/transcribe-refine.ts for what that is allowed to change.
  //
  // The bar stays up for it, because the words are visibly about to change and
  // a silent rewrite half a second after the mic closed reads as a glitch. The
  // run is not torn down until this resolves, which is also what keeps the
  // composer's claim alive long enough for the correction to be placed against
  // it — and what makes `runId` load-bearing, since a run that lasts past its
  // own ending can otherwise reach into the next one.
  const refineRun = useCallback(async (passage: string, runId: number) => {
    if (refineUnavailable || !worthRefining(passage)) return;
    setPhase('refining');
    const ac = new AbortController();
    refineAbort.current = ac;
    const timer = setTimeout(() => ac.abort(), REFINE_TIMEOUT_MS);
    try {
      const r = await authedFetch('/api/transcribe/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          sessionId,
          text: passage,
          style: readRealtimeStyle(),
          preceding: composerRef.current?.dictationBase() ?? '',
        }),
      });
      if (r.status === 503) { refineUnavailable = true; return; }
      if (!r.ok) return;
      const { text } = (await r.json()) as { text?: string };
      if (!text || text === passage || runIdRef.current !== runId) return;
      // Keep the reveal animation's idea of the world in step with the draft,
      // or a later frame would type the un-refined passage back in.
      targetRef.current = text;
      shownRef.current = text;
      composerRef.current?.refineDictationTail(text);
    } catch {
      // Aborted, offline, malformed — the passage in the draft is already the
      // user's words. Nothing to report and nothing to retry.
    } finally {
      clearTimeout(timer);
    }
  }, [sessionId, composerRef, setPhase]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    setPhase('finishing');
    if (modeRef.current === 'batch') {
      // Nothing is streaming; transcribe what we recorded and append it.
      const runId = runIdRef.current;
      void flushBatch().then(async (text) => {
        const passage = joinSegments([committedRef.current, text]);
        settleTo(passage);
        if (!text) onNotice?.('这段没听清，什么也没转出来');
        await refineRun(passage, runId);
        if (runIdRef.current === runId) teardown();
      });
      return;
    }
    // Capture first, socket second: no audio may arrive after 'stop'.
    streamRef.current?.cancel();
    streamRef.current = null;
    sockRef.current?.stop();
  }, [flushBatch, settleTo, teardown, onNotice, refineRun, setPhase]);

  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    settleTo('');
    teardown();
  }, [settleTo, teardown]);

  const armSilenceStop = useCallback((isSilent: boolean) => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    if (!isSilent) return;
    silenceTimer.current = setTimeout(() => {
      onNotice?.('没听到声音，已结束听写');
      stop();
    }, SILENCE_STOP_MS);
  }, [onNotice, stop]);

  const start = useCallback((src: DictationSource) => {
    if (activeRef.current) {
      // Still listening — every press opens the run as 'hold', so this is the
      // same run being re-labelled hands-free, not a second one.
      if (statusRef.current !== 'refining') { setSource(src); onActiveChange?.(true, src); return; }
      // Only the end-of-run pass is left, and it has just lost its claim on the
      // draft: the words it was correcting are about to have new ones after
      // them. Drop it (teardown aborts) and let this press start a real run.
      teardown();
    }
    runIdRef.current += 1;
    setActiveBoth(true, src);
    setSource(src);
    setPhase(realtimeUnavailable ? 'offline' : 'connecting');
    setPending(0);
    setHint(null);
    setStartedAt(Date.now());
    modeRef.current = realtimeUnavailable ? 'batch' : 'stream';
    committedRef.current = '';
    targetRef.current = '';
    shownRef.current = '';
    composerRef.current?.beginDictation();
    clockTimer.current = setInterval(() => tick((n) => n + 1), 1000);

    // Socket first (its handshake overlaps the mic opening), but startStreaming
    // still runs inside this same synchronous gesture — on iOS a getUserMedia
    // that isn't in the gesture's own call stack loses its privilege.
    if (modeRef.current === 'stream') {
      try {
        sockRef.current = openAsrSocket(sessionId, readRealtimeStyle(), {
          onReady: () => setPhase('listening'),
          onState: (st) => {
            setPending(st.pending);
            committedRef.current = st.tail;
            // Closed sentences AND the partial, revealed a character at a time.
            typeTo(joinSegments([st.tail, st.partial]));
          },
          // A closed sentence is safely in the draft — the capture layer no
          // longer needs to keep its audio for the fallback.
          onSentence: () => streamRef.current?.mark(),
          onDone: (tail) => {
            const runId = runIdRef.current;
            settleTo(tail);
            void refineRun(tail, runId).then(() => { if (runIdRef.current === runId) teardown(); });
          },
          onFailure: (message) => degradeToBatch(message, /not configured/.test(message)),
        });
      } catch (e) {
        console.error('[dictation] socket open failed', e);
        degradeToBatch('socket open failed', false);
      }
    }

    startStreaming({
      onChunk: (pcm) => sockRef.current?.send(pcm),
      onLevel: setLevel,
      onSilence: (s) => { setSilent(s); armSilenceStop(s); },
      maxMs: RUN_MAX_MS,
      onAutoStop: () => { onNotice?.('听写时长到上限，已结束'); stop(); },
    })
      .then((stream) => {
        // The run can be gone by the time the mic opens (cancelled, released).
        if (!activeRef.current) { stream.cancel(); return; }
        streamRef.current = stream;
      })
      .catch((e: unknown) => {
        const denied = (e as DOMException)?.name === 'NotAllowedError';
        onNotice?.(denied ? '麦克风被拒绝，去系统设置开启' : '麦克风不可用');
        teardown();
      });
  }, [sessionId, composerRef, setActiveBoth, teardown, degradeToBatch, armSilenceStop, stop, onNotice, typeTo, settleTo, onActiveChange, refineRun, setPhase]);

  useImperativeHandle(ref, () => ({
    start,
    stop,
    cancel,
    get active() { return activeRef.current; },
  }), [start, stop, cancel]);

  if (!active) return null;
  return (
    <DictationBar
      source={source}
      cancelArmed={cancelArmed}
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
