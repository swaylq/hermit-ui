'use client';

// The press-and-hold voice overlay — WeChat's, followed closely.
//
// Hold the "Ask anything" box and this takes the screen: the words appear in a
// bubble as they are recognised, and where the finger is when it lifts decides
// what happens to them —
//
//   lift where you are  → send it
//   slid LEFT  (取消)    → throw it away
//   slid RIGHT (编辑)    → drop it into the composer to fix before sending
//
// WHAT IS COPIED FROM WECHAT, and why each piece is there:
//
// · THREE surfaces at the bottom, not two. WeChat draws the send target as a
//   pale dome filling the bottom of the screen, with 取消 and 编辑 as panels
//   riding its shoulders. Two pills and an unmarked middle made "just lift"
//   look like the absence of a choice rather than one of three; the dome is
//   the third choice, drawn, and it lights while the finger is on it.
// · The state lives ON the surfaces. Exactly one of them is lit at any moment,
//   and the lit one says what lifting does. There is no separate hint line to
//   read (it is back only for 授权 and 收尾, which no surface can express).
// · Green, and it moves with your voice. WeChat's blob is the whole reason
//   holding your phone and talking feels alive rather than modal. The level
//   arrives through lib/mic-level.ts and is written to `--lv` on the root here;
//   the blob and the timer dot scale off it in CSS. No React state is involved,
//   because that signal updates ~12×/second.
// · The transcript sits in a WeChat-green bubble with a tail pointing down at
//   the finger. Sliding onto 取消 greys it and strikes it through, the way
//   WeChat greys the blob you are about to throw away.
//
// This file DRAWS ONLY. The gesture, the dictation run and the draft all live in
// composer.tsx — which already owns the text these words are being written into,
// so putting the zone arithmetic anywhere else would mean two components
// agreeing about one string. Nothing here is interactive: the finger is still
// captured by the press layer over the textarea, so a button here could never
// receive its own click. The three surfaces are targets for HIT-TESTING (the
// composer reads the two pills' rects through the refs it passes in), not
// controls.

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

/** WeChat's green, and the paler green it fills a sent bubble with. */
const WX_GREEN = '#07C160';
const WX_BUBBLE = '#95EC69';

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
  // running through "收尾中…" would be timing the wrong thing.
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
      {/* The words, where you can read them — above the finger, not under it. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-end gap-3 px-6 pb-[12vh]">
        {phase !== 'auth' && (
          <div className="flex items-center gap-2 text-[11px] font-medium tabular-nums text-white/60">
            <span
              // Scales with the voice, like the blob, so the row stays alive
              // once the transcript has replaced the blob itself.
              style={{
                background: cancelling ? 'rgba(255,255,255,0.35)' : WX_GREEN,
                transform: 'scale(calc(1 + var(--lv) * 0.9))',
                boxShadow: cancelling ? 'none' : `0 0 8px ${WX_GREEN}`,
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
          <Bubble tint={cancelling ? 'rgba(255,255,255,0.14)' : WX_BUBBLE} glow={!cancelling}>
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
        <div className="relative h-[196px] shrink-0">
          {/* The send dome, behind the pills and bleeding off three edges, so
              the whole bottom of the screen is "just lift". */}
          <div
            style={{ borderRadius: '50% 50% 0 0 / 100% 100% 0 0' }}
            className={cn(
              'absolute inset-x-[-14%] bottom-[-56px] h-[152px] transition-colors duration-150',
              zone === 'send' ? 'bg-white/85' : 'bg-white/[0.13]',
            )}
          >
            <div
              className={cn(
                'flex items-center justify-center gap-1.5 pt-7 text-[15px] font-medium transition-colors duration-150',
                zone === 'send' ? 'text-neutral-800' : 'text-transparent',
              )}
            >
              {phase === 'finishing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {phase === 'finishing' ? '正在发送' : '松开发送'}
            </div>
          </div>

          <Pill
            pillRef={cancelRef}
            side="left"
            active={cancelling}
            label="取消"
          />
          <Pill
            pillRef={editRef}
            side="right"
            active={zone === 'edit' && phase === 'listening'}
            label="编辑"
          />
        </div>
      )}
    </div>,
    document.body,
  );
}

/** A WeChat bubble: rounded, with a tail pointing down at the finger. */
function Bubble({
  tint,
  glow = false,
  children,
}: {
  tint: string;
  glow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative max-w-[min(30rem,84vw)]">
      <div
        style={{
          background: tint,
          boxShadow: glow
            ? '0 18px 50px -12px rgba(0,0,0,0.7), 0 0 calc(14px + var(--lv) * 30px) rgba(7,193,96,0.55)'
            : '0 18px 50px -12px rgba(0,0,0,0.6)',
        }}
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
          background: dimmed ? 'rgba(255,255,255,0.18)' : WX_GREEN,
          transform: 'scale(calc(1 + var(--lv) * 0.85))',
          boxShadow: dimmed ? 'none' : `0 0 34px 6px rgba(7,193,96,0.55)`,
        }}
        className="h-[52px] w-[52px] rounded-full transition-transform duration-100 ease-out"
      />
    </div>
  );
}

function Pill({
  pillRef,
  side,
  active,
  label,
}: {
  pillRef: React.RefObject<HTMLDivElement | null>;
  side: 'left' | 'right';
  active: boolean;
  label: string;
}) {
  return (
    <div
      ref={pillRef}
      className={cn(
        'absolute bottom-[66px] flex h-[104px] w-[50%] items-center justify-center',
        'rounded-[30px] text-[16px] font-medium transition-colors duration-150',
        side === 'left' ? 'left-[-4%] pr-[6%]' : 'right-[-4%] pl-[6%]',
        active ? 'bg-white text-neutral-900' : 'bg-white/[0.14] text-white/70',
      )}
    >
      {label}
    </div>
  );
}
