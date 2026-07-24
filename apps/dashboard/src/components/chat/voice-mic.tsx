'use client';

// Draggable floating mic for voice input. Lives inside SessionPane so it can
// drop the transcript straight into the active chat's composer draft.
//
// Gesture (pointer events, unified touch/mouse):
//   · pointerdown  → open the mic IN-GESTURE (iOS requires getUserMedia inside a
//                    user gesture) and optimistically show "recording".
//   · move > 8px within 180 ms → it was a DRAG: abandon the recording, reposition
//                    the FAB (persisted to localStorage, clamped to the viewport).
//   · hold ≥ 180 ms (no early move) → locked recording; later moves are ignored.
//   · pointerup while recording → stop + POST to /api/transcribe → onTranscript.
//   · a too-short press (< 400 ms) is treated as an accidental tap (hint, no send).
//
// The simple state pill here is replaced by the aurora <VoiceHUD> in P3.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import { authedFetch } from '@/lib/asst-fetch';
import { startRecording, type VoiceRecorder } from '@/lib/voice-capture';
import { VoiceHUD } from '@/components/chat/voice-hud';

type Phase = 'idle' | 'recording' | 'transcribing' | 'error';

const FAB = 56; // button diameter (px)
const DRAG_PX = 8; // early move beyond this = drag, not record
const HOLD_MS = 180; // hold this long with no early move = locked recording
const MIN_MS = 400; // shorter press = accidental tap, don't send
const MAX_MS = 60_000; // recording ceiling
const POS_KEY = 'hermit:voice-mic-pos';

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
    /* private mode / bad json — fall through to default */
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

  // Position: load once, keep clamped inside the viewport on resize / rotate.
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
      // The gesture may have ended / become a drag while getUserMedia resolved.
      if (g.current.mode !== 'deciding' && g.current.mode !== 'recording') { rec.cancel(); return; }
      recorderRef.current = rec;
      g.current.recAt = Date.now();
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
      // Early movement → it's a drag, not a hold. Abandon the just-opened mic.
      clearTimeout(gg.holdTimer);
      gg.mode = 'dragging';
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setPhase('idle');
      setLevel(0);
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
        try { localStorage.setItem(POS_KEY, JSON.stringify(np)); } catch { /* private mode */ }
        return;
      }
      if (mode === 'deciding' || mode === 'recording') void stopAndTranscribe();
    },
    [stopAndTranscribe],
  );

  if (hidden || !pos) return null;

  const recording = phase === 'recording';
  return (
    <div className="fixed z-40 touch-none select-none" style={{ left: pos.x, top: pos.y }}>
      {phase !== 'idle' ? (
        <div className="absolute bottom-full right-0 mb-2">
          <VoiceHUD phase={phase} level={level} />
        </div>
      ) : hint ? (
        <div className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-full border border-border bg-background/95 px-3 py-1 text-xs text-foreground shadow-sm backdrop-blur">
          {hint}
        </div>
      ) : null}
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        aria-label="语音输入（长按说话，拖动可移位）"
        title="长按说话，拖动可移位"
        className={cn(
          'flex items-center justify-center rounded-full shadow-lg transition-colors cursor-pointer',
          recording ? 'bg-rose-500 text-white' : phase === 'transcribing' ? 'bg-amber-500 text-white' : 'bg-foreground text-background hover:bg-foreground/90',
        )}
        style={{
          width: FAB,
          height: FAB,
          transform: recording ? `scale(${1 + Math.min(0.25, level * 0.3)})` : undefined,
        }}
      >
        <Mic className="h-6 w-6" />
      </button>
    </div>
  );
}
