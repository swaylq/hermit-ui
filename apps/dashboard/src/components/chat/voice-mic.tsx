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
//   · pointerdown  → open the mic IN-GESTURE (a getUserMedia made inside the
//                    gesture's own call stack is "privileged", which is what buys
//                    the long no-reprompt window on iOS) and arm the HUD.
//   · move > 8px within 180 ms → it was a DRAG: abandon the recording, reposition
//                    the FAB (persisted to localStorage, clamped to the viewport).
//   · hold ≥ 180 ms (no early move) → locked recording; later moves are ignored.
//   · pointerup while recording → stop + POST to /api/transcribe → onTranscript.
//   · a too-short press (< 400 ms) is treated as an accidental tap (hint, no send).
//
// NOT-YET-AUTHORIZED touches take a different path (iOS PWAs re-ask constantly —
// the grant is in-memory and dies ~10 min after capture stops, or on any relaunch):
// opening the mic on pointerdown would throw the system alert at someone who is
// merely DRAGGING the button, and the alert then swallows the touch so pointerup
// never arrives — the old code sat expanded and "recording" with no mic behind it.
// So when the permission isn't already granted we open nothing on pointerdown; the
// press becomes an explicit "tap to allow" that fires the request on RELEASE, from
// its own gesture, with the button staying a circle + spinner until it resolves.

import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Loader2, Mic, XIcon } from 'lucide-react';
import { authedFetch } from '@/lib/asst-fetch';
import { isTouchPrimary } from '@/lib/save-file';
import {
  startRecording,
  releaseWarmMic,
  canOpenMicSilently,
  refreshMicPermission,
  requestMicAccess,
  type VoiceRecorder,
} from '@/lib/voice-capture';
import { VoiceWave, type WavePhase } from '@/components/chat/voice-wave';
import { FAB, HOLD_MS, useFabDock } from '@/components/chat/fab-dock';
import { Dialog, DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// 'arming' = waiting on the mic (device opening, or the user answering the
// permission alert). Deliberately NOT expanded: the capsule means "we are
// recording you", and showing it before a track exists is the bug this fixes.
type Phase = 'idle' | 'arming' | 'recording' | 'transcribing' | 'error';

const EXP_MAX = 212; // expanded capsule width ceiling
const MIN_MS = 400; // shorter press = accidental tap, don't send
const MAX_MS = 60_000; // recording ceiling
const SPRING = 'cubic-bezier(0.34, 1.35, 0.5, 1)';

// ── polish style ────────────────────────────────────────────────────────────
// Which transcription polish this device uses. Double-click the mic to change it;
// the choice lives in localStorage (per-browser, like the mic position and
// visibility) and rides along with each transcription as the `style` form field.
type MicStyle = 'rewrite' | 'minimal';
const STYLE_KEY = 'hermit:voice-mic-style';
const DOUBLE_TAP_MS = 300;
// The tap that OPENS the settings dialog on touch also produces a synthesized
// `click` a few ms later; by then the backdrop covers the screen, so the click
// lands on it and would instantly close the dialog. Close requests in this window
// after opening are ignored so the dialog survives its own tap-through.
const OUTSIDE_CLOSE_GRACE_MS = 400;
const STYLE_OPTIONS: { value: MicStyle; label: string; desc: string }[] = [
  { value: 'rewrite', label: '改写润色', desc: '修改并重写转写文字，更贴合任务场景的表达习惯（默认）' },
  { value: 'minimal', label: '保留原话', desc: '尽量保留原始转写，仅纠正错别字、英文拼写和语法问题' },
];
function readMicStyle(): MicStyle {
  try { return localStorage.getItem(STYLE_KEY) === 'minimal' ? 'minimal' : 'rewrite'; } catch { return 'rewrite'; }
}


// memo: VoiceMic lives inside SessionPane, which re-renders on every SSE
// streaming tick / poll. Its props (sessionId, hidden boolean, stable
// onTranscript callback) don't change on those, so without memo it re-ran its
// whole gesture-setup + canvas-child render body ~4×/sec during a reply for
// nothing. All dynamic rendering is driven by its own internal state, so memo
// is behaviour-preserving.
export const VoiceMic = memo(function VoiceMic({
  sessionId,
  hidden,
  onTranscript,
}: {
  sessionId: string;
  hidden: boolean;
  onTranscript: (text: string) => void;
}) {
  // Position + dragging belong to the dock now — the mic is one button in a group
  // that moves together. What stays here is what a PRESS means, which is the part
  // with all the teeth (record vs drag vs ask-for-permission).
  const dock = useFabDock();
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [style, setStyle] = useState<MicStyle>('rewrite');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dialogOpenedAt = useRef(0);

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
    keyArmTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    armingKey: false, // right-Option held, waiting out the hold delay
    byKey: false, // current recording was started by the PTT key (not the button)
    needsAuth: false, // this press must ask for permission on release, not record
    pointerDown: false, // finger/button still down — false means nobody is holding
    lastTapAt: 0, // time of the previous quick tap — two taps ≤ DOUBLE_TAP_MS opens settings
    tapHintTimer: 0 as unknown as ReturnType<typeof setTimeout>,
  });


  // Release the warm mic on unmount (leaving the chat) so it doesn't linger.
  useEffect(() => () => { clearTimeout(g.current.tapHintTimer); releaseWarmMic(); }, []);

  // The polish style lives in localStorage — read it once on mount. It only ever
  // changes through the settings popup on this same button, so no cross-tab sync.
  useEffect(() => { setStyle(readMicStyle()); }, []);

  // Keep the cached permission answer fresh — it expires on its own (iOS drops the
  // grant ~10 min after capture stops) and pointerdown has to read it synchronously.
  // Poll slowly + on wake; the query is a local IPC, not a network call.
  useEffect(() => {
    void refreshMicPermission();
    const id = setInterval(() => { if (!document.hidden) void refreshMicPermission(); }, 15_000);
    const onVisible = () => { if (!document.hidden) void refreshMicPermission(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const finishTranscribe = useCallback(
    async (wav: Blob) => {
      setPhase('transcribing');
      try {
        const fd = new FormData();
        fd.append('sessionId', sessionId);
        fd.append('wav', wav, 'voice.wav');
        fd.append('style', style);
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
    [sessionId, onTranscript, style],
  );

  const stopAndTranscribe = useCallback(async () => {
    const gg = g.current;
    gg.byKey = false;
    gg.mode = 'idle';
    gg.armingKey = false;
    clearTimeout(gg.keyArmTimer);
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) { setPhase('idle'); return; }
    const tooShort = Date.now() - gg.recAt < MIN_MS;
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

  const beginRecording = useCallback(async (maxMs: number = MAX_MS) => {
    const gg = g.current;
    try {
      const rec = await startRecording({
        onLevel: setLevel,
        maxMs,
        onAutoStop: () => { void stopAndTranscribe(); },
      });
      // The gesture can be gone by the time the mic opens: a drag took over, the
      // press was released, or a permission alert swallowed the pointerup. Handing
      // the recorder over then would leave a HUD nobody can close until the 60 s
      // cap — so drop it and reset instead.
      const holderGone = !gg.byKey && !gg.pointerDown;
      if ((gg.mode !== 'deciding' && gg.mode !== 'recording') || holderGone) {
        rec.cancel();
        if (holderGone && gg.mode !== 'idle') { gg.mode = 'idle'; setPhase('idle'); setLevel(0); }
        return;
      }
      recorderRef.current = rec;
      gg.recAt = Date.now();
      setStartedAt(Date.now());
      // Pointer path: the hold timer armed the HUD, this flips it live. The key
      // path owns its phase (it discards a pre-commit release), so leave it alone
      // while it's still arming.
      if (gg.mode === 'recording' && !gg.armingKey) setPhase('recording');
    } catch (e) {
      const denied = (e as DOMException)?.name === 'NotAllowedError';
      setPhase('error');
      setHint(denied ? '麦克风被拒绝，去系统设置开启' : '麦克风不可用');
      setTimeout(() => { setPhase('idle'); setHint(null); }, denied ? 3600 : 2600);
      gg.mode = 'idle';
      gg.byKey = false;
      gg.armingKey = false;
      clearTimeout(gg.keyArmTimer);
    }
  }, [stopAndTranscribe]);

  // First-run (and post-expiry) authorization: fired from pointerUP so the system
  // alert never lands mid-press. requestMicAccess() runs synchronously inside this
  // gesture — do NOT await anything before it or WebKit stops treating it as
  // user-initiated.
  const authorizeMic = useCallback(() => {
    setPhase('arming');
    setHint('请允许使用麦克风');
    requestMicAccess()
      .then(() => {
        setPhase('idle');
        setHint('已授权 · 按住说话');
        setTimeout(() => setHint(null), 2400);
      })
      .catch((e: unknown) => {
        const denied = (e as DOMException)?.name === 'NotAllowedError';
        setPhase('error');
        setHint(denied ? '麦克风被拒绝，去系统设置开启' : '麦克风不可用');
        setTimeout(() => { setPhase('idle'); setHint(null); }, denied ? 3600 : 2600);
      })
      .finally(() => { void refreshMicPermission(); });
  }, []);

  // Desktop push-to-talk: hold RIGHT Option (⌥, code "AltRight") to record — the
  // same voice key as Keyo. Capture starts on keydown (so the first words aren't
  // clipped); the ~180 ms arm only decides whether to KEEP it (commit → show the
  // recording HUD) or discard it. Pressing any OTHER key while arming aborts it —
  // that's an Option+arrow / Option+delete edit, not talking. Held recording gets
  // a 5-min cap (a stuck key won't run forever).
  useEffect(() => {
    if (isTouchPrimary()) return; // desktop only — touch uses the button
    const KEY = 'AltRight';
    const gg = g.current;
    const discardKeyPtt = () => {
      clearTimeout(gg.keyArmTimer);
      gg.armingKey = false;
      gg.byKey = false;
      gg.mode = 'idle';
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setPhase('idle');
      setLevel(0);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== KEY) {
        // Another key WHILE ARMING (before commit) ⇒ an Option+key shortcut, not
        // talking — drop the just-opened capture. Once committed we ignore other
        // keys so a stray keypress can't kill an active recording.
        if (gg.armingKey) discardKeyPtt();
        return;
      }
      if (e.repeat || hidden || gg.mode !== 'idle') return;
      // Reserve the gesture + start capturing NOW (from keydown); the timer commits.
      gg.armingKey = true;
      gg.byKey = true;
      gg.mode = 'recording';
      void beginRecording(300_000);
      gg.keyArmTimer = setTimeout(() => {
        if (gg.armingKey && gg.byKey && !hidden) {
          gg.armingKey = false; // committed
          setPhase('recording');
          setHint(null);
        }
      }, HOLD_MS);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== KEY || !gg.byKey) return;
      if (gg.armingKey) { discardKeyPtt(); return; } // released before commit → tap, no send
      void stopAndTranscribe(); // committed → stop + transcribe
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [hidden, beginRecording, stopAndTranscribe]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (phase === 'transcribing' || g.current.mode !== 'idle') return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const gg = g.current;
      gg.mode = 'deciding';
      gg.downAt = Date.now();
      gg.pointerDown = true;
      gg.px = e.clientX;
      gg.py = e.clientY;
      dock.onDown(e); // the dock decides whether this becomes a group drag
      setHint(null);
      clearTimeout(gg.tapHintTimer); // a new press cancels a pending tap hint
      // Open the mic only once the hold is confirmed, so a DRAG never opens it (no
      // stray mic indicator). Exception: on touch we open on pointerdown — only a
      // request made inside this gesture is privileged, and that privilege is what
      // keeps iOS from re-prompting later — and a drag's cancel() releases it.
      // …unless we aren't authorized yet: then opening here would ask permission of
      // someone who may only be dragging, so the press becomes a "tap to allow"
      // handled on release (endGesture) instead.
      const touch = isTouchPrimary();
      gg.needsAuth = touch && !canOpenMicSilently();
      if (touch && !gg.needsAuth) void beginRecording();
      gg.holdTimer = setTimeout(() => {
        if (gg.mode !== 'deciding') return;
        if (gg.needsAuth) { setHint('松手授权麦克风'); return; } // stay a circle
        gg.mode = 'recording';
        // Show the recording capsule only once a track exists — until then it's
        // 'arming' (circle + spinner), so a pending permission alert can never
        // leave a fake "recording" HUD on screen.
        setPhase(recorderRef.current ? 'recording' : 'arming');
        if (!touch) void beginRecording();
      }, HOLD_MS);
    },
    [phase, beginRecording, dock],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const gg = g.current;
      if (gg.mode === 'idle') return;
      // The dock owns the drag threshold and moves the whole group; it tells us the
      // moment this press stopped being a press. Everything below is the mic
      // abandoning the recording it was about to make.
      const isDrag = dock.onMove(e);
      if (isDrag && gg.mode !== 'dragging') {
        clearTimeout(gg.holdTimer);
        gg.mode = 'dragging';
        gg.needsAuth = false; // moving the button is not a request to be recorded
        recorderRef.current?.cancel();
        recorderRef.current = null;
        setPhase('idle');
        setHint(null);
        setLevel(0);
      }
    },
    [dock],
  );

  // A press that never held into a recording (released before HOLD_MS) is a TAP.
  // Two taps within DOUBLE_TAP_MS open the style settings; a lone tap just hints
  // '长按说话', delayed by the double-tap window so the hint can't flash in the
  // gap before a second tap lands.
  const onTap = useCallback(() => {
    const gg = g.current;
    clearTimeout(gg.tapHintTimer);
    // Touch opens the mic on pointerdown; a sub-400ms press is never a real
    // recording, so cancel it silently instead of transcribing.
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec) { rec.cancel(); setLevel(0); }
    const now = Date.now();
    const isDouble = now - gg.lastTapAt <= DOUBLE_TAP_MS;
    gg.lastTapAt = isDouble ? 0 : now;
    setPhase('idle');
    if (isDouble) {
      setHint(null);
      dialogOpenedAt.current = Date.now();
      setSettingsOpen(true);
      return;
    }
    gg.tapHintTimer = setTimeout(() => {
      setHint('长按说话');
      setTimeout(() => setHint(null), 1500);
    }, DOUBLE_TAP_MS);
  }, []);

  const endGesture = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const gg = g.current;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      clearTimeout(gg.holdTimer);
      const mode = gg.mode;
      const needsAuth = gg.needsAuth;
      gg.mode = 'idle';
      gg.pointerDown = false;
      gg.needsAuth = false;
      // The dock persists the new position and reports whether this was a drag; a
      // drag is never also a recording.
      if (dock.onUp(e) || mode === 'dragging') return;
      // Unauthorized press → this release IS the permission request (its own
      // gesture, finger already up, so the alert can't strand the UI).
      if (needsAuth) { authorizeMic(); return; }
      if (mode === 'recording') { void stopAndTranscribe(); return; }
      // mode === 'deciding' → a quick tap, never a recording: the first tap of a
      // double-tap (settings) or an accidental tap (hint). stopAndTranscribe is
      // deliberately NOT called — its too-short path would flash '长按说话'
      // immediately and eat the double-tap window.
      void onTap();
    },
    [stopAndTranscribe, authorizeMic, onTap, dock],
  );

  // Safety net for a press that never gets its pointerup: the tab going away
  // mid-recording (iOS backgrounding kills capture anyway — voice-capture drops the
  // warm mic on hidden). Without this the HUD would sit "recording" until the cap.
  useEffect(() => {
    const bail = () => {
      if (!document.hidden) return;
      const gg = g.current;
      if (gg.mode === 'idle' && !recorderRef.current) return;
      clearTimeout(gg.holdTimer);
      clearTimeout(gg.tapHintTimer);
      gg.mode = 'idle';
      gg.pointerDown = false;
      gg.needsAuth = false;
      gg.byKey = false;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setPhase('idle');
      setLevel(0);
      setHint(null);
    };
    document.addEventListener('visibilitychange', bail);
    return () => document.removeEventListener('visibilitychange', bail);
  }, []);
  const chooseStyle = useCallback((s: MicStyle) => {
    setStyle(s);
    try { localStorage.setItem(STYLE_KEY, s); } catch { /* private mode */ }
    setSettingsOpen(false);
  }, []);
  // See OUTSIDE_CLOSE_GRACE_MS: a tap that opened the dialog fires a leftover
  // `click` into the backdrop a few ms later. Ignore closes inside that window.
  const handleSettingsOpenChange = useCallback((open: boolean) => {
    if (!open && Date.now() - dialogOpenedAt.current < OUTSIDE_CLOSE_GRACE_MS) return;
    setSettingsOpen(open);
  }, []);

  if (hidden) return null;

  // 'arming' stays a circle on purpose — the capsule is the "you are being
  // recorded" signal and must not appear before a mic track exists.
  const arming = phase === 'arming';
  const active = phase === 'recording' || phase === 'transcribing' || phase === 'error';
  // The recording capsule grows sideways. The dock is anchored by its LEFT edge, so
  // a capsule near the right edge has to grow leftwards instead — done with a
  // negative margin rather than by moving the dock, which would drag the sibling
  // button along with it.
  const vw = window.innerWidth;
  const expW = Math.min(EXP_MAX, vw - 24);
  const expandsLeft = dock.x + expW + 8 > vw;
  const width = active ? expW : FAB;
  const shift = active && expandsLeft ? Math.min(dock.x - 8, expW - FAB) : 0;

  const elapsed = phase === 'recording' && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  const glow =
    phase === 'recording'
      ? '0 10px 34px -4px rgba(79,123,255,0.55), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : phase === 'arming'
      ? '0 8px 26px -6px rgba(129,140,248,0.45), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : phase === 'transcribing'
      ? '0 10px 34px -4px rgba(56,189,248,0.5), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : phase === 'error'
      ? '0 10px 34px -4px rgba(244,63,94,0.5), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : '0 6px 20px -6px rgba(0,0,0,0.55)';

  return (
    <>
      <div
        className="relative"
        style={{ marginLeft: -shift, transition: dock.dragging ? 'none' : `margin-left 0.42s ${SPRING}` }}
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
          aria-label="语音输入（长按说话，拖动可移位；未授权时点一下授权；双击打开设置）"
          title="长按说话，拖动可移位（桌面可按住右 Option 说话；双击打开设置）"
          className="relative flex items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#111319]/85 backdrop-blur-xl cursor-pointer"
          style={{
            width,
            height: FAB,
            boxShadow: glow,
            transition: dock.dragging ? 'none' : `width 0.42s ${SPRING}, box-shadow 0.35s ease`,
          }}
        >
          {active && (
            <div className="pointer-events-none absolute inset-0">
              <VoiceWave phase={phase as WavePhase} level={level} />
            </div>
          )}
          <Mic
            className="pointer-events-none absolute h-5 w-5 text-white/85 transition-all duration-200"
            style={{
              opacity: active || arming ? 0 : 1,
              transform: active || arming ? 'scale(0.5)' : 'scale(1)',
            }}
          />
          {arming && (
            <Loader2 className="pointer-events-none absolute h-5 w-5 animate-spin text-white/85" />
          )}
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

      {/* Double-click the mic → this settings popup. Composed on the base-ui
          primitives directly (not the stock DialogContent) because the dock sits at
          z-[70] and the stock dialog is z-50 — the mic would float above its own
          settings popup. Both overlay and popup get z-[80]. */}
      <Dialog open={settingsOpen} onOpenChange={handleSettingsOpenChange}>
        <DialogPortal>
          <DialogOverlay className="z-[80]" />
          <DialogPrimitive.Popup
            data-slot="dialog-content"
            className="fixed top-1/2 left-1/2 z-[80] grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold text-foreground">语音输入风格</p>
              <p className="text-xs text-muted-foreground">双击麦克风可随时改回。保存在本机浏览器。</p>
            </div>
            <div className="flex flex-col gap-2">
              {STYLE_OPTIONS.map((o) => {
                const selected = style === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => chooseStyle(o.value)}
                    aria-pressed={selected}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors cursor-pointer',
                      selected ? 'border-foreground/30 bg-accent' : 'border-border hover:bg-accent/50',
                    )}
                  >
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-foreground/30">
                      {selected && <Check className="h-3 w-3 text-emerald-500" />}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">{o.label}</span>
                      <span className="text-[11px] leading-snug text-muted-foreground">{o.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <DialogPrimitive.Close
              render={
                <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    </>
  );
});
