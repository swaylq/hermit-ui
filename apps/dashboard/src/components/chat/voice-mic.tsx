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
//                         again to finish. (Two taps inside DOUBLE_TAP_MS mean
//                         the settings popup instead — nobody says anything in
//                         300 ms, so the run that first tap opened is dropped.)
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
import { Check, Loader2, Mic, XIcon } from 'lucide-react';
import { isTouchPrimary } from '@/lib/save-file';
import {
  releaseWarmMic,
  canOpenMicSilently,
  refreshMicPermission,
  requestMicAccess,
} from '@/lib/voice-capture';
import { readMicStyle, writeMicStyle, type MicStyle } from '@/lib/voice-style';
import { FAB, HOLD_MS, useFabDock } from '@/components/chat/fab-dock';
import type { DictationSource } from '@/components/chat/dictation-dock';
import { Dialog, DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// 'arming' = waiting on the permission alert. Deliberately not the live look:
// that means "we are recording you", and showing it before a track exists is a lie.
type Phase = 'idle' | 'arming' | 'error';

/** Held longer than this and the release means "done talking". */
const PTT_MS = 400;
/** Slide the finger this far up the screen to throw the run away. */
const CANCEL_DY = 56;

// ── polish style ────────────────────────────────────────────────────────────
// Which transcription polish this device uses (lib/voice-style.ts — shared with
// the dictation dock, which sends it to the realtime socket). Double-tap the mic
// to change it; the choice lives in localStorage, per-browser, like the mic's
// position and visibility.
const DOUBLE_TAP_MS = 300;
// The tap that OPENS the settings dialog on touch also produces a synthesized
// `click` a few ms later; by then the backdrop covers the screen, so the click
// lands on it and would instantly close the dialog. Close requests in this window
// after opening are ignored so the dialog survives its own tap-through.
const OUTSIDE_CLOSE_GRACE_MS = 400;
const STYLE_OPTIONS: { value: MicStyle; label: string; desc: string }[] = [
  { value: 'rewrite', label: '改写润色', desc: '修改并重写转写文字，更贴合任务场景的表达习惯' },
  { value: 'minimal', label: '保留原话', desc: '尽量保留原始转写，仅纠正错别字、英文拼写和语法问题（实时听写默认）' },
];

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
  const [style, setStyle] = useState<MicStyle>('rewrite');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dialogOpenedAt = useRef(0);

  const g = useRef({
    mode: 'idle' as 'idle' | 'deciding' | 'holding' | 'dragging',
    downAt: 0,
    py: 0,
    holdTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    keyArmTimer: 0 as unknown as ReturnType<typeof setTimeout>,
    byKey: false, // the live run was started by the push-to-talk key
    needsAuth: false, // this press must ask for permission on release, not record
    startedRun: false, // THIS press opened the run (so its release ends it)
    lastTapAt: 0, // previous quick tap — two inside DOUBLE_TAP_MS opens settings
    tapStartedRun: false, // …and that previous tap had opened a run, so undo it
  });
  // pointerdown must know whether a run is live before React re-renders.
  const dictatingRef = useRef(dictating);
  dictatingRef.current = dictating;

  useEffect(() => () => { releaseWarmMic(); }, []);
  useEffect(() => { setStyle(readMicStyle()); }, []);

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
  // hands-free, finish by tapping again. Two taps inside DOUBLE_TAP_MS mean the
  // settings popup instead, and the run the first one opened is dropped (nobody
  // says anything in 300 ms, so nothing is lost).
  const onTap = useCallback(() => {
    const gg = g.current;
    const now = Date.now();
    const isDouble = now - gg.lastTapAt <= DOUBLE_TAP_MS;
    const startedRun = gg.startedRun;
    gg.startedRun = false;
    gg.lastTapAt = isDouble ? 0 : now;
    if (isDouble) {
      if (startedRun || gg.tapStartedRun) onDictateCancel();
      gg.tapStartedRun = false;
      setHint(null);
      dialogOpenedAt.current = Date.now();
      setSettingsOpen(true);
      return;
    }
    gg.tapStartedRun = startedRun;
    // This press opened a run → hand it over to hands-free. It didn't → the run
    // was already going and this tap ends it.
    if (startedRun) onDictate('tap');
    else onDictateStop();
  }, [onDictate, onDictateStop, onDictateCancel]);

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

  const chooseStyle = useCallback((s: MicStyle) => {
    setStyle(s);
    writeMicStyle(s);
    setSettingsOpen(false);
  }, []);
  // See OUTSIDE_CLOSE_GRACE_MS: a tap that opened the dialog fires a leftover
  // `click` into the backdrop a few ms later. Ignore closes inside that window.
  const handleSettingsOpenChange = useCallback((open: boolean) => {
    if (!open && Date.now() - dialogOpenedAt.current < OUTSIDE_CLOSE_GRACE_MS) return;
    setSettingsOpen(open);
  }, []);

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
    <>
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
          aria-label={live ? '结束听写（上滑取消）' : '语音输入（按住说话，点一下免提听写，拖动可移位；双击打开设置）'}
          title={live ? '松手或再点一下结束，上滑取消' : '按住说话，点一下免提听写，拖动可移位（桌面可按住右 Option 说话；双击打开设置）'}
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

      {/* Double-tap the mic → this settings popup. Composed on the base-ui
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
              render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
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
