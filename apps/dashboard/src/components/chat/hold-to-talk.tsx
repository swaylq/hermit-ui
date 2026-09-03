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
// This file DRAWS ONLY. The gesture, the dictation run and the draft all live
// in composer.tsx — which already owns the text these words are being written
// into, so putting the zone arithmetic anywhere else would mean two components
// agreeing about one string. Nothing here is interactive: the finger is still
// captured by the press layer over the textarea, so a button here could never
// receive its own click. `cancelRef` / `editRef` are HIT BOXES the composer
// measures — deliberately plain rectangles over the two arcs, because a rect is
// what getBoundingClientRect can report and a slide that overshoots into the
// corner above one should land on it anyway.

import { useEffect, useRef, useState } from 'react';
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

/** The one accent this app already uses for "the mic is open". */
const ROSE = '#fb7185';

export function HoldToTalkOverlay({
  zone,
  phase,
  text,
  cancelRef,
  editRef,
}: {
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

  // Counts from the moment this mounted, which is the moment the run began.
  // Frozen once the finger lifts — the recording has stopped, and a clock still
  // running through the send would be timing the wrong thing.
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (phase !== 'listening') return;
    const id = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Loudness → `--lv` on the root, straight to the DOM. Everything that reacts
  // to the voice reads that one variable, so this is the only subscriber and it
  // never touches React state. Held at 0 while the finger is over 取消 — a blob
  // still bouncing over the words you are about to throw away reports on
  // nothing. 编辑 is still recording, so it keeps moving.
  const rootRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef(true);
  useEffect(() => subscribeMicLevel((lv) => {
    rootRef.current?.style.setProperty('--lv', liveRef.current ? lv.toFixed(3) : '0');
  }), []);
  // Which states the blob is allowed to move in. From an effect, not from the
  // render (a ref must not be written during one) — and applied to the node
  // straight away, since the gate above would otherwise only bite on the next
  // audio block and 取消 has to still the blob on the frame you reach it.
  useEffect(() => {
    liveRef.current = phase === 'listening' && zone !== 'cancel';
    if (!liveRef.current) rootRef.current?.style.setProperty('--lv', '0');
  }, [zone, phase]);

  if (!mounted) return null;

  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const cancelling = zone === 'cancel' && phase === 'listening';
  // 授权 is the one state no bottom surface can express — there is no choice to
  // make, so there is nothing to light. Everything else is written on whichever
  // surface is lit.
  const aside = phase === 'auth' ? '松手 · 允许使用麦克风' : null;

  return createPortal(
    // pointer-events-none throughout: the press layer over the textarea holds
    // the pointer capture for this whole gesture, and an overlay that swallowed
    // events would only be able to steal them from it.
    <div
      ref={rootRef}
      style={{ '--lv': '0' } as React.CSSProperties}
      className="pointer-events-none fixed inset-0 z-[120] flex flex-col overflow-hidden bg-black/65 backdrop-blur-[6px]"
    >
      {/* The words, where you can read them — up around the middle of the
          screen, nowhere near the thumb. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-end gap-3 px-6 pb-[20vh]">
        {phase !== 'auth' && (
          <div className="flex items-center gap-2 text-[11px] font-medium tabular-nums text-white/60">
            <span
              // Scales with the voice, like the blob, so the row stays alive
              // once the transcript has replaced the blob itself.
              style={{
                background: cancelling ? 'rgba(255,255,255,0.35)' : ROSE,
                transform: 'scale(calc(1 + var(--lv) * 0.9))',
                boxShadow: cancelling ? 'none' : `0 0 8px ${ROSE}`,
              }}
              className="h-1.5 w-1.5 rounded-full transition-transform duration-100 ease-out"
            />
            {mmss}
          </div>
        )}

        {phase === 'auth' ? (
          <Bubble tint="rgba(255,255,255,0.12)">
            <span className="flex items-center gap-2 text-white/70">
              <Mic className="h-4 w-4" />
              需要麦克风权限才能说话
            </span>
          </Bubble>
        ) : text ? (
          <Bubble tint={cancelling ? 'rgba(255,255,255,0.14)' : '#ffffff'}>
            {/* The tail is what just arrived, so the box shows its END. */}
            <span
              className={cn(
                'block max-h-[42vh] overflow-hidden whitespace-pre-wrap break-words text-[15px] leading-relaxed',
                '[display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:8]',
                cancelling ? 'text-white/45 line-through decoration-white/35' : 'text-neutral-900',
              )}
            >
              {text}
            </span>
          </Bubble>
        ) : (
          <VoiceBlob dimmed={cancelling} />
        )}

        {aside && <div className="text-[13px] font-medium text-white/75">{aside}</div>}
      </div>

      {/* The three targets. During 授权 there is no choice to make — releasing
          anywhere opens the system alert — so drawing targets would be a lie. */}
      {phase !== 'auth' && (
        <div className="relative shrink-0" style={{ height: ZONE_H }}>
          {/* ── the send disc ────────────────────────────────────────────── */}
          <div
            style={{
              width: R_DOME * 2,
              height: R_DOME * 2,
              marginLeft: -R_DOME,
              bottom: -(DROP + R_DOME),
            }}
            className={cn(
              'absolute left-1/2 rounded-full transition-colors duration-150',
              zone === 'send' ? 'bg-white/85' : 'bg-white/[0.13]',
            )}
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

          {/* ── the two arcs ─────────────────────────────────────────────── */}
          <Arc side="left" active={cancelling} label="取消" />
          <Arc side="right" active={zone === 'edit' && phase === 'listening'} label="编辑" />

          {/* Hit boxes, invisible. See the header. */}
          <div ref={cancelRef} className="absolute bottom-[100px] left-0 right-[calc(50%+15px)] h-[105px]" />
          <div ref={editRef} className="absolute bottom-[100px] left-[calc(50%+15px)] right-0 h-[105px]" />
        </div>
      )}
    </div>,
    document.body,
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
function Arc({ side, active, label }: { side: 'left' | 'right'; active: boolean; label: string }) {
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
}

/** A bubble with a tail pointing down at the finger. */
function Bubble({ tint, children }: { tint: string; children: React.ReactNode }) {
  return (
    <div className="relative max-w-[min(30rem,84vw)]">
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
