'use client';

// The press-and-hold voice overlay — WeChat's, measured off a screenshot.
//
// Hold the "Ask anything" box and this takes the screen: the words appear in a
// bubble as they are recognised, and where the finger is when it lifts decides
// what happens to them —
//
//   lift where you are  → send it
//   slid LEFT  (取消)    → throw it away
//   slid RIGHT (编辑)    → drop it into the composer to fix before sending
//
// ── THE BOTTOM OF THE SCREEN IS ONE CIRCLE ─────────────────────────────────
//
// Everything down there is concentric, and it is worth knowing that before
// reading a single number: there is ONE circle, centred on the screen's
// vertical midline, 419px BELOW the bottom edge. The send target is that
// circle filled in. 取消 and 编辑 are a band around it, split at the top into
// two round-ended arcs. So the three targets never touch and never overlap,
// and each one curves the way a thumb does when it swings across the bottom of
// a phone — which is the whole reason WeChat draws it this way.
//
// The radii below were read off a WeChat screenshot on a 393pt-wide screen
// (sample pixel columns, find the luminance steps, fit circles to them). They
// reproduce it to within a pixel, so treat them as measurements rather than
// taste — re-measure rather than nudge:
//
//   dome radius        540   → apex sits 121px above the bottom edge
//   band inner radius  558   → 18px of dark between the band and the dome
//   band outer radius  620   → so the band is 62px thick
//   cap offset        46.5   → each arc's round end, from the midline; the two
//                              ends therefore leave a 31px gap at the top
//
// They are absolute px on purpose. The assembly is anchored to the bottom edge,
// where the thumb is; on a wider phone the arcs simply run further off the
// sides, which is what should happen and what WeChat does.
//
// ── WHAT IS NOT COPIED ─────────────────────────────────────────────────────
//
// The colours. WeChat is green because WeChat is green; this app is greyscale
// (every token in globals.css is `oklch(… 0 0)`) and its one accent for "the
// mic is open" is the rose already on the composer's mic button. So: white
// bubble, rose blob, grey surfaces. Only the geometry is borrowed.
//
// ── AND ONE THING THAT IS NOT WECHAT AT ALL ────────────────────────────────
//
// The lit surface is labelled. WeChat's dome is blank — its users have held
// that button for a decade. Ours have not, so the surface under the thumb says
// 松开发送 while it is lit. It is the only thing telling a first-time user that
// lifting is a choice rather than just letting go.
//
// ── COMING AND GOING ───────────────────────────────────────────────────────
//
// Both directions are animated, which means this cannot simply be mounted and
// unmounted by the composer: a React unmount takes the node out of the DOM on
// the spot, and there is nothing left to fade. So the composer renders this
// ALWAYS and passes `open`; the leave window is owned here. Same controlled-
// `show` + plain-CSS-transition pattern as overlay.tsx and collapse.tsx —
// deliberately not the `animate-in` keyframe classes, which get stuck at
// opacity:0 in this app (see the note in overlay.tsx).
//
// One consequence worth knowing: on release the composer clears the draft in
// the same commit that sets `open` false, so the live `text` prop is already
// empty while the fade-out is still playing. The overlay therefore keeps a
// snapshot of what was last on screen and fades THAT away — otherwise the
// bubble would empty itself halfway through its own exit, which reads as a bug.
//
// ── WHY THIS IS FUSSY ABOUT PAINTING ───────────────────────────────────────
//
// The shapes here are enormous: the send disc is 1080px across and the band's
// ring is 1240px, of which maybe 200px is ever on screen. At 3× that is a lot
// of pixels to rasterise, and the first version of the enter/leave animation
// was visibly rough on a phone because of it. Four rules keep it smooth, and
// all four look like clutter until you take one away:
//
//  · The zone stack CLIPS (`overflow-hidden`). Without it those circles are
//    only bounded by the viewport and get painted far larger than they show.
//  · Lit/unlit is an OPACITY change, never a background-color one. Colour
//    animates on the main thread and repaints the whole circle each frame;
//    opacity is handed to the compositor.
//  · `--lv` lives on the stage, NOT on the root. Writing a custom property
//    invalidates style for everything below it, twelve times a second — and
//    below the root is every one of those circles, none of which read it.
//  · `will-change` is set only while this is on screen, which is a second or
//    two. It is a promise the compositor pays memory for; leaving it on a
//    permanently-mounted element would be worse than not using it.
//
// This file DRAWS ONLY. The gesture, the dictation run and the draft all live
// in composer.tsx — which already owns the text these words are being written
// into, so putting the zone arithmetic anywhere else would mean two components
// agreeing about one string. Nothing here is interactive: the finger is still
// captured by the press layer over the textarea, so a button here could never
// receive its own click. `cancelRef` / `editRef` are HIT BOXES the composer
// measures — deliberately plain rectangles over the two arcs, because a rect is
// what getBoundingClientRect can report and a slide that overshoots into the
// corner above one should land on it anyway.

import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import { subscribeMicLevel } from '@/lib/mic-level';

/** Where the finger is, and therefore what lifting it will do. */
export type HoldZone = 'send' | 'cancel' | 'edit';

/**
 * 'auth' — the mic isn't authorized yet, so this press asks instead of recording
 * (the grant has to be requested from the RELEASE; see composer.tsx).
 * 'listening' — a run is live. 'finishing' — released to send, waiting for the
 * last words (and the whole-passage correction) to land before they go out.
 */
export type HoldPhase = 'auth' | 'listening' | 'finishing';

// The circle everything at the bottom is cut from. See the header.
const DROP = 419;        // how far below the bottom edge its centre sits
const R_DOME = 540;      // the filled disc — "lift here and it sends"
const R_OUT = 620;       // outer edge of the 取消 / 编辑 band
const BAND = 62;         // band thickness, so its inner edge is 558
const CAP = 46.5;        // each arc's round end, either side of the midline
const R_MID = R_OUT - BAND / 2;
/** Height above the bottom edge of the band's centreline, `d` px off the midline. */
const midAt = (d: number) => Math.sqrt(R_MID * R_MID - d * d) - DROP;
/** Tall enough to contain the band's highest point (~201px). */
const ZONE_H = 224;
/** Where each label sits along its arc, measured from the midline. */
const LABEL_D = 114;

/**
 * Short on purpose. This arrives 260ms into a press that has not shown anything
 * yet (HOLD_MS in composer.tsx), so any transition here is delay stacked on top
 * of delay — and the longer it runs, the longer there is for a dropped frame to
 * be visible on it. Enter is a touch slower than leave so arriving still reads
 * as landing rather than snapping. Both must match the timeout that unmounts.
 */
const ENTER_MS = 140;
const LEAVE_MS = 120;

/** The one accent this app already uses for "the mic is open". */
const ROSE = '#fb7185';

export function HoldToTalkOverlay({
  open,
  exit,
  zone,
  phase,
  text,
  cancelRef,
  editRef,
}: {
  /** Is the gesture live? False starts the leave animation, it does not unmount. */
  open: boolean;
  /**
   * What was on screen when the gesture ended — drawn for the length of the
   * leave, because by then the live props have moved on: sending clears the
   * draft in the same commit that closes this, and `zone` has gone back to its
   * resting value. The composer captures it, since the composer is where every
   * one of the three exits is decided.
   */
  exit: { zone: HoldZone; phase: HoldPhase; text: string } | null;
  zone: HoldZone;
  phase: HoldPhase;
  /** The transcript so far — what will be sent. */
  text: string;
  cancelRef: React.RefObject<HTMLDivElement | null>;
  editRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Portalled to <body>: the composer sits inside the chat page's flex stack,
  // and any ancestor with a transform would turn `fixed` into "fixed to that
  // ancestor". A portal makes the viewport the frame no matter what.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount gate; there is no document on the server
  useEffect(() => setMounted(true), []);

  // ── coming and going ──────────────────────────────────────────────────────
  // `entered` is false for one painted frame after opening, so the transition
  // has a starting position to run from; `leaving` keeps the subtree alive
  // while it fades back out.
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    // Adjusting state during the render that noticed the change — React's own
    // pattern for it, and the reason there is no flicker: an effect would paint
    // one frame of the previous state first.
    setWasOpen(open);
    setEntered(false);
    setLeaving(!open);
  }
  useEffect(() => {
    if (!open) return;
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, [open]);
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(false), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);
  const show = open && entered;

  // Loudness → `--lv` on the root, straight to the DOM. Everything that reacts
  // to the voice reads that one variable, so this is the only subscriber and it
  // never touches React state. Held at 0 while the finger is over 取消 — a blob
  // still bouncing over the words you are about to throw away reports on
  // nothing. 编辑 is still recording, so it keeps moving.
  const stageRef = useRef<HTMLDivElement>(null);
  const movingRef = useRef(true);
  useEffect(() => subscribeMicLevel((lv) => {
    stageRef.current?.style.setProperty('--lv', movingRef.current ? lv.toFixed(3) : '0');
  }), []);
  // Which states the blob is allowed to move in. From an effect, not from the
  // render (a ref must not be written during one) — and applied to the node
  // straight away, since the gate above would otherwise only bite on the next
  // audio block and 取消 has to still the blob on the frame you reach it.
  useEffect(() => {
    movingRef.current = open && phase === 'listening' && zone !== 'cancel';
    if (!movingRef.current) stageRef.current?.style.setProperty('--lv', '0');
  }, [open, zone, phase]);

  // While open, draw the live props; on the way out, what the composer handed
  // us at release. Nothing at all once the leave window has closed — which is
  // also what resets <Meter>, since it unmounts along with everything else.
  const view = open ? { zone, phase, text } : leaving ? exit : null;
  if (!mounted || !view) return null;

  const { phase: vPhase, zone: vZone, text: vText } = view;
  const cancelling = vZone === 'cancel' && vPhase === 'listening';
  const ms = `${show ? ENTER_MS : LEAVE_MS}ms`;

  return createPortal(
    // pointer-events-none throughout: the press layer over the textarea holds
    // the pointer capture for this whole gesture, and an overlay that swallowed
    // events would only be able to steal them from it.
    <div
      style={{ opacity: show ? 1 : 0, transitionDuration: ms, willChange: 'opacity' }}
      className="pointer-events-none fixed inset-0 z-[120] flex flex-col overflow-hidden bg-black/70 backdrop-blur-[3px] transition-opacity ease-out"
    >
      {/* The words, where you can read them — up around the middle of the
          screen, nowhere near the thumb. */}
      <div
        ref={stageRef}
        style={{
          '--lv': '0',
          transform: show ? 'none' : 'translateY(10px) scale(0.97)',
          transitionDuration: ms,
          willChange: 'transform',
        } as React.CSSProperties}
        className="flex min-h-0 flex-1 flex-col items-center justify-end gap-3 px-6 pb-[20vh] transition-transform ease-out"
      >
        {vPhase !== 'auth' && <Meter running={open && vPhase === 'listening'} dimmed={cancelling} />}

        {vPhase === 'auth' ? (
          <Bubble tint="rgba(255,255,255,0.12)">
            <span className="flex items-center gap-2 text-white/70">
              <Mic className="h-4 w-4" />
              需要麦克风权限才能说话
            </span>
          </Bubble>
        ) : vText ? (
          <Bubble tint={cancelling ? 'rgba(255,255,255,0.14)' : '#ffffff'}>
            {/* The tail is what just arrived, so the box shows its END. */}
            <span
              className={cn(
                'block max-h-[42vh] overflow-hidden whitespace-pre-wrap break-words text-[15px] leading-relaxed',
                '[display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:8]',
                cancelling ? 'text-white/45 line-through decoration-white/35' : 'text-neutral-900',
              )}
            >
              {vText}
            </span>
          </Bubble>
        ) : (
          <VoiceBlob dimmed={cancelling} />
        )}

        {vPhase === 'auth' && (
          <div className="text-[13px] font-medium text-white/75">松手 · 允许使用麦克风</div>
        )}
      </div>

      {/* The three targets. During 授权 there is no choice to make — releasing
          anywhere opens the system alert — so drawing targets would be a lie. */}
      {vPhase !== 'auth' && <Zones zone={vZone} phase={vPhase} show={show} ms={ms} />}

      {/* Hit boxes, invisible, and OUTSIDE the sliding container on purpose:
          the composer measures them mid-gesture, and a rect that is still
          drifting up would answer for where the arc is going to be rather than
          where it is. Only while the gesture is live — during the leave there
          is nothing left to aim at. */}
      {open && vPhase !== 'auth' && (
        <>
          <div ref={cancelRef} className="absolute bottom-[100px] left-0 right-[calc(50%+15px)] h-[105px]" />
          <div ref={editRef} className="absolute bottom-[100px] left-[calc(50%+15px)] right-0 h-[105px]" />
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * The elapsed clock, and the dot that breathes with the voice.
 *
 * Its own component for two reasons: one tick a second re-renders this row
 * instead of the whole overlay, and `secs` resets by being a fresh mount each
 * run — the overlay draws nothing between runs, so this unmounts with it.
 * Frozen once the finger lifts: the recording has stopped, and a clock still
 * running through the send would be timing the wrong thing.
 */
function Meter({ running, dimmed }: { running: boolean; dimmed: boolean }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium tabular-nums text-white/60">
      <span
        style={{
          background: dimmed ? 'rgba(255,255,255,0.35)' : ROSE,
          transform: 'scale(calc(1 + var(--lv) * 0.9))',
          boxShadow: dimmed ? 'none' : `0 0 8px ${ROSE}`,
        }}
        className="h-1.5 w-1.5 rounded-full transition-transform duration-100 ease-out"
      />
      {`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}
    </div>
  );
}

/**
 * One half of the band: a ring clipped to this side of the gap, plus a disc
 * closing the cut off with a round end. The union is a curved bar with one
 * rounded tip, which is not a shape CSS has a name for.
 *
 * The clip sits on a FULL-WIDTH wrapper so its `50%` means the middle of the
 * screen; the ring is a child of that and is still centred on the screen.
 */
/**
 * The bottom of the screen, as one memoised block.
 *
 * Everything in here is expensive to paint and none of it depends on the words:
 * while you talk, the transcript rewrites the overlay's props about 36 times a
 * second, and without this memo the disc, both arcs and their labels are
 * reconciled every one of those times — on the same main thread the audio
 * capture callback is trying to run on.
 */
const Zones = memo(function Zones({
  zone,
  phase,
  show,
  ms,
}: {
  zone: HoldZone;
  phase: HoldPhase;
  show: boolean;
  ms: string;
}) {
  return (
    <div
      className="relative shrink-0 overflow-hidden transition-transform ease-out"
      style={{
        height: ZONE_H,
        transform: show ? 'none' : 'translateY(24px)',
        transitionDuration: ms,
        willChange: 'transform',
      }}
    >
      {/* ── the send disc ────────────────────────────────────────────────── */}
      <div
        style={{
          width: R_DOME * 2,
          height: R_DOME * 2,
          marginLeft: -R_DOME,
          bottom: -(DROP + R_DOME),
          opacity: zone === 'send' ? 0.85 : 0.13,
        }}
        className="absolute left-1/2 rounded-full bg-white transition-opacity duration-150"
      />
      <div
        style={{ bottom: R_DOME - DROP - 47 }}
        className={cn(
          'absolute inset-x-0 flex items-center justify-center gap-1.5 text-[15px] font-medium transition-colors duration-150',
          zone === 'send' ? 'text-neutral-800' : 'text-transparent',
        )}
      >
        {phase === 'finishing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {phase === 'finishing' ? '正在发送' : '松开发送'}
      </div>

      {/* ── the two arcs ─────────────────────────────────────────────────── */}
      <Arc side="left" active={zone === 'cancel' && phase === 'listening'} label="取消" />
      <Arc side="right" active={zone === 'edit' && phase === 'listening'} label="编辑" />
    </div>
  );
});

// memo: the transcript rewrites the overlay's props about 36 times a second
// while you talk, and none of it reaches these three props. Without this, both
// arcs re-render at that rate for nothing.
const Arc = memo(function Arc({ side, active, label }: { side: 'left' | 'right'; active: boolean; label: string }) {
  const left = side === 'left';
  return (
    <>
      {/* Ring and cap are both solid white and share ONE opacity. Tinting them
          separately looks right until they meet: two 14% whites overlapping
          composite to 26%, and the join shows up as a bright disc sitting on
          the band. Fading the pair as a group composites once. */}
      <div
        className="absolute inset-0 transition-opacity duration-150"
        style={{ opacity: active ? 1 : 0.14 }}
      >
        <div
          className="absolute inset-0"
          style={{ clipPath: left ? `inset(0 calc(50% + ${CAP}px) 0 0)` : `inset(0 0 0 calc(50% + ${CAP}px))` }}
        >
          <div
            style={{
              width: R_OUT * 2,
              height: R_OUT * 2,
              marginLeft: -R_OUT,
              bottom: -(DROP + R_OUT),
              borderWidth: BAND,
            }}
            className="absolute left-1/2 rounded-full border-solid border-white"
          />
        </div>
        <div
          style={{
            width: BAND,
            height: BAND,
            marginLeft: left ? -(CAP + BAND / 2) : CAP - BAND / 2,
            bottom: midAt(CAP) - BAND / 2,
          }}
          className="absolute left-1/2 rounded-full bg-white"
        />
      </div>
      <div
        style={{ marginLeft: left ? -LABEL_D - 60 : LABEL_D - 60, bottom: midAt(LABEL_D) - 10 }}
        className={cn(
          'absolute left-1/2 h-5 w-[120px] text-center text-[16px] font-medium leading-5 transition-colors duration-150',
          active ? 'text-neutral-900' : 'text-white/70',
        )}
      >
        {label}
      </div>
    </>
  );
});

/** A bubble with a tail pointing down at the finger. */
function Bubble({ tint, children }: { tint: string; children: React.ReactNode }) {
  return (
    // willChange: this text is rewritten ~36×/s and it sits on top of the
    // overlay's backdrop-filter. Its own layer keeps those repaints from going
    // back through the filter.
    <div className="relative max-w-[min(30rem,84vw)]" style={{ willChange: 'transform' }}>
      <div
        style={{ background: tint, boxShadow: '0 18px 50px -12px rgba(0,0,0,0.7)' }}
        className="max-h-[42vh] overflow-hidden rounded-[20px] px-4 py-3"
      >
        {children}
      </div>
      <span
        aria-hidden="true"
        style={{ background: tint }}
        className="absolute bottom-[-5px] left-1/2 h-[14px] w-[14px] -translate-x-1/2 rotate-45 rounded-[3px]"
      />
    </div>
  );
}

/** The blob, before any words have arrived. Breathes with the voice. */
function VoiceBlob({ dimmed }: { dimmed: boolean }) {
  return (
    <div className="relative flex h-[120px] w-[120px] items-center justify-center">
      <span
        aria-hidden="true"
        style={{
          background: dimmed ? 'rgba(255,255,255,0.18)' : ROSE,
          transform: 'scale(calc(1 + var(--lv)))',
          boxShadow: dimmed ? 'none' : '0 0 34px 6px rgba(251,113,133,0.45)',
        }}
        className="h-[42px] w-[42px] rounded-full transition-transform duration-100 ease-out"
      />
    </div>
  );
}
