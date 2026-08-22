'use client';

// Draggable floating mic. It has exactly one job now: decide what a press means
// and hand that to the dictation dock, which owns the mic stream, the socket and
// the text. There is no second "record it all, upload on release" pipeline any
// more — every press is realtime dictation, and when realtime can't be had the
// dock degrades to a recording by itself, invisibly.
//
// PRESS SEMANTICS. Capture starts on POINTERDOWN, before we know whether this is
// a tap or a hold, because waiting to find out clips the first syllable. What the
// release means is decided after the fact:
//
//   released < PTT_MS   → it was a tap. The run KEEPS GOING, hands-free; tap
//                         again to finish.
//   released ≥ PTT_MS   → it was push-to-talk. The release finishes the run.
//   slid up ≥ CANCEL_DY → cancel, without lifting a finger (the WeChat idiom).
//   moved early         → it was a drag. Reposition, and drop the run.
//
// The button therefore must NOT disappear while a run is live: a button that
// unmounts mid-press never delivers its pointerup, and a held run would never
// end. The bar keeps its own controls clear of it instead (see dictation-bar).
//
// NOT-YET-AUTHORIZED touches take a different path (iOS PWAs re-ask constantly —
// the grant is in-memory and dies ~10 min after capture stops, or on any
// relaunch): opening the mic on pointerdown would throw the system alert at
// someone who is merely DRAGGING the button, and the alert then swallows the
// touch so pointerup never arrives. So when the permission isn't already granted
// we open nothing on pointerdown; the press becomes an explicit "tap to allow"
// that fires the request on RELEASE, from its own gesture.

import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Loader2, Mic, XIcon } from 'lucide-react';
import { isTouchPrimary } from '@/lib/save-file';
import {
  releaseWarmMic,
  canOpenMicSilently,
  refreshMicPermission,
  requestMicAccess,
} from '@/lib/voice-capture';
import { FAB, HOLD_MS, useFabDock } from '@/components/chat/fab-dock';
import type { DictationSource } from '@/components/chat/dictation-dock';
import { cn } from '@/lib/utils';

// 'arming' = waiting on the permission alert. Deliberately not the live look:
// that means "we are recording you", and showing it before a track exists is a lie.
type Phase = 'idle' | 'arming' | 'error';

/** Held longer than this and the release means "done talking". */
const PTT_MS = 400;
/** Slide the finger this far up the screen to throw the run away. */
const CANCEL_DY = 56;

// memo: VoiceMic lives inside SessionPane, which re-renders on every SSE
// streaming tick / poll. Its props don't change on those, so without memo it
// re-ran its whole gesture-setup body ~4×/sec during a reply for nothing.
export const VoiceMic = memo(function VoiceMic({
  hidden,
  dictating,
  cancelArmed,
  onDictate,
  onDictateStop,
  onDictateCancel,
  onSlideCancelArm,
}: {
  hidden: boolean;
  /** A run is live (started by this button or still going hands-free). */
  dictating: boolean;
  /** The finger has slid up far enough that releasing will cancel. */
  cancelArmed: boolean;
  /** Start a run of this kind — or, if one is live, make it that kind. */
  onDictate: (source: DictationSource) => void;
  onDictateStop: () => void;
  onDictateCancel: () => void;
  /** Report the slide-to-cancel arm state so the bar and button can show it. */
  onSlideCancelArm: (armed: boolean) => void;
}) {
  // Position + dragging belong to the dock — the mic is one button in a group
  // that moves together. What stays here is what a PRESS means.
  const dock = useFabDock();
  const [phase, setPhase] = useState<Phase>('idle');
  const [hint, setHint] = useState<string | null>(null);

  const g = useRef({
    mode: 'idle' as 'idle' | 'deciding' | 'holding' | 'dragging',
    downAt: 0,
    py: 0,
    holdTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    keyArmTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    byKey: false, // the live run was started by the push-to-talk key
    needsAuth: false, // this press must ask for permission on release, not record
    startedRun: false, // THIS press opened the run (so its release ends it)
  });
  // pointerdown must know whether a run is live before React re-renders.
  const dictatingRef = useRef(dictating);
  dictatingRef.current = dictating;

  useEffect(() => () => { releaseWarmMic(); }, []);

  // Keep the cached permission answer fresh — it expires on its own (iOS drops
  // the grant ~10 min after capture stops) and pointerdown reads it synchronously.
  useEffect(() => {
    void refreshMicPermission();
    const id = setInterval(() => { if (!document.hidden) void refreshMicPermission(); }, 15_000);
    const onVisible = () => { if (!document.hidden) void refreshMicPermission(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

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
        setHint('已授权 · 再按一下开始说话');
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

  // Desktop push-to-talk: hold RIGHT Option (⌥). Capture starts on keydown so the
  // first words aren't clipped; the ~180 ms arm only decides whether to KEEP it.
  // Pressing any OTHER key while arming aborts it — that's an Option+arrow edit,
  // not talking.
  useEffect(() => {
    if (isTouchPrimary()) return; // desktop only — touch uses the button
    const KEY = 'AltRight';
    const gg = g.current;
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== KEY) {
        if (gg.byKey && gg.keyArmTimer) { clearTimeout(gg.keyArmTimer); gg.keyArmTimer = 0 as never; gg.byKey = false; onDictateCancel(); }
        return;
      }
      if (e.repeat || hidden || gg.mode !== 'idle' || dictatingRef.current) return;
      gg.byKey = true;
      onDictate('hold');
      gg.keyArmTimer = setTimeout(() => { gg.keyArmTimer = 0 as never; }, HOLD_MS);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== KEY || !gg.byKey) return;
      gg.byKey = false;
      if (gg.keyArmTimer) { clearTimeout(gg.keyArmTimer); gg.keyArmTimer = 0 as never; onDictateCancel(); return; } // tap, not talk
      onDictateStop();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [hidden, onDictate, onDictateStop, onDictateCancel]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (phase === 'arming' || g.current.mode !== 'idle') return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const gg = g.current;
      gg.mode = 'deciding';
      gg.downAt = Date.now();
      gg.py = e.clientY;
      gg.startedRun = false;
      dock.onDown(e); // the dock decides whether this becomes a group drag
      setHint(null);

      // Open the mic NOW unless we'd be asking permission of someone who might
      // only be dragging. A run already going is being ENDED by this press, not
      // started, so don't open a second one.
      const touch = isTouchPrimary();
      gg.needsAuth = touch && !canOpenMicSilently();
      if (!gg.needsAuth && !dictatingRef.current) {
        gg.startedRun = true;
        onDictate('hold');
      }
      gg.holdTimer = setTimeout(() => {
        if (gg.mode !== 'deciding') return;
        if (gg.needsAuth) { setHint('松手授权麦克风'); return; }
        gg.mode = 'holding'; // committed to push-to-talk; later moves mean cancel
      }, PTT_MS);
    },
    [phase, dock, onDictate],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const gg = g.current;
      if (gg.mode === 'idle') return;
      if (gg.mode === 'holding') {
        // Slide up off the button to throw the run away.
        onSlideCancelArm(gg.py - e.clientY >= CANCEL_DY);
        return;
      }
      // The dock owns the drag threshold and moves the whole group; it tells us
      // the moment this press stopped being a press.
      if (dock.onMove(e) && gg.mode !== 'dragging') {
        clearTimeout(gg.holdTimer);
        gg.mode = 'dragging';
        gg.needsAuth = false; // moving the button is not a request to be recorded
        if (gg.startedRun) { gg.startedRun = false; onDictateCancel(); }
        setHint(null);
      }
    },
    [dock, onDictateCancel, onSlideCancelArm],
  );

  // A press released before PTT_MS is a TAP, and a tap LEAVES THE RUN GOING —
  // hands-free, finish by tapping again.
  const onTap = useCallback(() => {
    const gg = g.current;
    const startedRun = gg.startedRun;
    gg.startedRun = false;
    // This press opened a run → hand it over to hands-free. It didn't → the run
    // was already going and this tap ends it.
    if (startedRun) onDictate('tap');
    else onDictateStop();
  }, [onDictate, onDictateStop]);

  const endGesture = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const gg = g.current;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      clearTimeout(gg.holdTimer);
      const mode = gg.mode;
      const needsAuth = gg.needsAuth;
      gg.mode = 'idle';
      gg.needsAuth = false;
      onSlideCancelArm(false);
      // The dock persists the new position and reports whether this was a drag;
      // a drag is never also a recording.
      if (dock.onUp(e) || mode === 'dragging') { gg.startedRun = false; return; }
      if (needsAuth) { authorizeMic(); return; }
      if (mode === 'holding') {
        gg.startedRun = false;
        if (cancelArmed) onDictateCancel();
        else onDictateStop();
        return;
      }
      onTap();
    },
    [dock, authorizeMic, onTap, onDictateStop, onDictateCancel, onSlideCancelArm, cancelArmed],
  );

  // Safety net for a press that never gets its pointerup: the tab going away
  // mid-run (iOS backgrounding kills capture anyway).
  useEffect(() => {
    const bail = () => {
      if (!document.hidden) return;
      const gg = g.current;
      if (gg.mode === 'idle' && !gg.startedRun) return;
      clearTimeout(gg.holdTimer);
      gg.mode = 'idle';
      gg.needsAuth = false;
      gg.byKey = false;
      gg.startedRun = false;
      onDictateStop();
      setPhase('idle');
      setHint(null);
    };
    document.addEventListener('visibilitychange', bail);
    return () => document.removeEventListener('visibilitychange', bail);
  }, [onDictateStop]);

  if (hidden) return null;

  const live = dictating && phase === 'idle';
  const glow =
    cancelArmed
      ? '0 10px 34px -4px rgba(244,63,94,0.6), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : live
      ? '0 10px 34px -4px rgba(56,189,248,0.55), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : phase === 'arming'
      ? '0 8px 26px -6px rgba(129,140,248,0.45), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : phase === 'error'
      ? '0 10px 34px -4px rgba(244,63,94,0.5), 0 4px 12px -2px rgba(0,0,0,0.5)'
      : '0 6px 20px -6px rgba(0,0,0,0.55)';

  return (
    <div className="relative">
      {hint && (
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
        aria-label={live ? '结束听写（上滑取消）' : '语音输入（按住说话，点一下免提听写，拖动可移位）'}
        title={live ? '松手或再点一下结束，上滑取消' : '按住说话，点一下免提听写，拖动可移位（桌面可按住右 Option 说话）'}
        className={cn(
          'relative flex items-center justify-center overflow-hidden rounded-full border backdrop-blur-xl cursor-pointer',
          cancelArmed ? 'border-rose-400/40 bg-[#2a1218]/90' : 'border-white/10 bg-[#111319]/85',
        )}
        style={{
          width: FAB,
          height: FAB,
          boxShadow: glow,
          transition: dock.dragging ? 'none' : `box-shadow 0.3s ease, background-color 0.2s ease`,
        }}
      >
        {live && !cancelArmed && (
          <span className="pointer-events-none absolute inset-0 animate-ping rounded-full border border-sky-300/40" />
        )}
        {phase === 'arming' ? (
          <Loader2 className="pointer-events-none absolute h-5 w-5 animate-spin text-white/85" />
        ) : cancelArmed ? (
          <XIcon className="pointer-events-none absolute h-5 w-5 text-rose-300" />
        ) : (
          <Mic
            className={cn(
              'pointer-events-none absolute h-5 w-5 transition-colors duration-200',
              live ? 'text-sky-300' : 'text-white/85',
            )}
          />
        )}
      </button>
    </div>
  );
});
