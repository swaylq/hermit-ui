'use client';

// Draggable floating mic for voice input. Lives inside SessionPane so it can drop
// the transcript straight into the active chat's composer draft.
//
// The button IS the HUD: idle it's a small dark-glass circle with a mic; hold to
// record and it springs open into a capsule with the aurora waveform flowing
// INSIDE it (level-reactive), the mic fading out, a pulsing REC dot + timer, and a
// coloured glow. Release → transcribing sweep → collapse back to a circle.
//
// Gesture (pointer events, unified touch/mouse):
//   · pointerdown  → open the mic IN-GESTURE (iOS requires getUserMedia inside a
//                    user gesture) and optimistically expand to "recording".
//   · move > 8px within 180 ms → it was a DRAG: abandon the recording, reposition
//                    the FAB (persisted to localStorage, clamped to the viewport).
//   · hold ≥ 180 ms (no early move) → locked recording; later moves are ignored.
//   · pointerup while recording → stop + POST to /api/transcribe → onTranscript.
//   · a too-short press (< 400 ms) is treated as an accidental tap (hint, no send).

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { authedFetch } from '@/lib/asst-fetch';
import { startRecording, type VoiceRecorder } from '@/lib/voice-capture';
import { VoiceWave, type WavePhase } from '@/components/chat/voice-wave';

type Phase = 'idle' | 'recording' | 'transcribing' | 'error';

const FAB = 56; // idle circle diameter (px)
const EXP_MAX = 212; // expanded capsule width ceiling
const DRAG_PX = 8; // early move beyond this = drag, not record
const HOLD_MS = 180; // hold this long with no early move = locked recording
const MIN_MS = 400; // shorter press = accidental tap, don't send
const MAX_MS = 60_000; // recording ceiling
const POS_KEY = 'hermit:voice-mic-pos';
const SPRING = 'cubic-bezier(0.34, 1.35, 0.5, 1)';

function clampPos(x: number, y: number) {
  const maxX = Math.max(8, window.innerWidth - FAB - 8);
  const maxY = Math.max(8, window.innerHeight - FAB - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}
function defaultPos() {
  return clampPos(window.innerWidth - FAB - 20, window.innerHeight - FAB - 120);
}
function loadPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof p.x === 'number' && typeof p.y === 'number') return clampPos(p.x, p.y);
  } catch {
    /* private mode / bad json */
  }
  return null;
}

export function VoiceMic({
  sessionId,
  hidden,
  onTranscript,
}: {
  sessionId: string;
  hidden: boolean;
  onTranscript: (text: string) => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [startedAt, setStartedAt] = useState(0);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const g = useRef({
    mode: 'idle' as 'idle' | 'deciding' | 'recording' | 'dragging',
    downAt: 0,
    recAt: 0,
    px: 0,
    py: 0,
    fx: 0,
    fy: 0,
    holdTimer: 0 as unknown as ReturnType<typeof setTimeout>,
  });

  useEffect(() => {
    setPos(loadPos() ?? defaultPos());
    const onResize = () => setPos((p) => (p ? clampPos(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const finishTranscribe = useCallback(
    async (wav: Blob) => {
      setPhase('transcribing');
      try {
        const fd = new FormData();
        fd.append('sessionId', sessionId);
        fd.append('wav', wav, 'voice.wav');
        const r = await authedFetch('/api/transcribe', { method: 'POST', body: fd });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { text?: string };
        const text = (data.text || '').trim();
        if (text) onTranscript(text);
        setPhase('idle');
      } catch {
        setPhase('error');
        setHint('转写失败，重试');
        setTimeout(() => { setPhase('idle'); setHint(null); }, 2600);
      }
    },
    [sessionId, onTranscript],
  );

  const stopAndTranscribe = useCallback(async () => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) { setPhase('idle'); return; }
    const tooShort = Date.now() - g.current.recAt < MIN_MS;
    const wav = await rec.stop();
    setLevel(0);
    if (tooShort || wav.size <= 44) {
      setPhase('idle');
      setHint('长按说话');
      setTimeout(() => setHint(null), 1500);
      return;
    }
    void finishTranscribe(wav);
  }, [finishTranscribe]);

  const beginRecording = useCallback(async () => {
    try {
      const rec = await startRecording({
        onLevel: setLevel,
        maxMs: MAX_MS,
        onAutoStop: () => { void stopAndTranscribe(); },
      });
      if (g.current.mode !== 'deciding' && g.current.mode !== 'recording') { rec.cancel(); return; }
      recorderRef.current = rec;
      g.current.recAt = Date.now();
      setStartedAt(Date.now());
    } catch {
      setPhase('error');
      setHint('麦克风不可用');
      setTimeout(() => { setPhase('idle'); setHint(null); }, 2600);
      g.current.mode = 'idle';
    }
  }, [stopAndTranscribe]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (phase === 'transcribing') return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const gg = g.current;
      gg.mode = 'deciding';
      gg.downAt = Date.now();
      gg.px = e.clientX;
      gg.py = e.clientY;
      gg.fx = pos?.x ?? 0;
      gg.fy = pos?.y ?? 0;
      setPhase('recording');
      setHint(null);
      void beginRecording(); // in-gesture (iOS)
      gg.holdTimer = setTimeout(() => { if (gg.mode === 'deciding') gg.mode = 'recording'; }, HOLD_MS);
    },
    [phase, pos, beginRecording],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const gg = g.current;
    if (gg.mode === 'idle') return;
    const dx = e.clientX - gg.px;
    const dy = e.clientY - gg.py;
    if (gg.mode === 'deciding' && Math.hypot(dx, dy) > DRAG_PX && Date.now() - gg.downAt < HOLD_MS) {
      clearTimeout(gg.holdTimer);
      gg.mode = 'dragging';
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setPhase('idle');
      setLevel(0);
      setDragging(true);
    }
    if (gg.mode === 'dragging') setPos(clampPos(gg.fx + dx, gg.fy + dy));
  }, []);

  const endGesture = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const gg = g.current;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      clearTimeout(gg.holdTimer);
      const mode = gg.mode;
      gg.mode = 'idle';
      if (mode === 'dragging') {
        const np = clampPos(gg.fx + (e.clientX - gg.px), gg.fy + (e.clientY - gg.py));
        setPos(np);
        setDragging(false);
        try { localStorage.setItem(POS_KEY, JSON.stringify(np)); } catch { /* private mode */ }
        return;
      }
      if (mode === 'deciding' || mode === 'recording') void stopAndTranscribe();
    },
    [stopAndTranscribe],
  );

  if (hidden || !pos) return null;

  const active = phase !== 'idle';
  const vw = window.innerWidth;
  const expW = Math.min(EXP_MAX, vw - 24);
  const expandsLeft = pos.x + expW + 8 > vw;
  const left = active && expandsLeft ? Math.max(8, pos.x + FAB - expW) : pos.x;
  const width = active ? expW : FAB;

  const elapsed = phase === 'recording' && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  const glow =
    phase === 'recording'
      ? '0 10px 34px -4px rgba(79,123,255,0.55), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : phase === 'transcribing'
      ? '0 10px 34px -4px rgba(56,189,248,0.5), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : phase === 'error'
      ? '0 10px 34px -4px rgba(244,63,94,0.5), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : '0 6px 20px -6px rgba(0,0,0,0.55)';

  return (
    <div
      className="fixed z-40 touch-none select-none"
      style={{ left, top: pos.y, transition: dragging ? 'none' : `left 0.42s ${SPRING}` }}
    >
      {!active && hint && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          {hint}
        </div>
      )}
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        aria-label="语音输入（长按说话，拖动可移位）"
        title="长按说话，拖动可移位"
        className="relative flex items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#111319]/85 backdrop-blur-xl cursor-pointer"
        style={{
          width,
          height: FAB,
          boxShadow: glow,
          transition: dragging ? 'none' : `width 0.42s ${SPRING}, box-shadow 0.35s ease`,
        }}
      >
        {active && (
          <div className="pointer-events-none absolute inset-0">
            <VoiceWave phase={phase as WavePhase} level={level} />
          </div>
        )}
        <Mic
          className="pointer-events-none absolute h-6 w-6 text-white/85 transition-all duration-200"
          style={{ opacity: active ? 0 : 1, transform: active ? 'scale(0.5)' : 'scale(1)' }}
        />
        {phase === 'recording' && (
          <>
            <span className="pointer-events-none absolute left-4 h-2 w-2 animate-pulse rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]" />
            <span className="pointer-events-none absolute right-4 text-[11px] font-medium tabular-nums text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]">
              {mmss}
            </span>
          </>
        )}
        {phase === 'transcribing' && (
          <Loader2 className="pointer-events-none absolute right-4 h-3.5 w-3.5 animate-spin text-white/90" />
        )}
        {phase === 'error' && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]">
            {hint ?? '出错了'}
          </span>
        )}
      </button>
    </div>
  );
}
