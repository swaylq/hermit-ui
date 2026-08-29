'use client';

// The press-and-hold voice overlay — WeChat's idiom, on the composer.
//
// Hold the "Ask anything" box and this takes the screen: the words appear in a
// bubble as they are recognised, and where the finger is when it lifts decides
// what happens to them —
//
//   lift where you are  → send it
//   slid LEFT  (取消)    → throw it away
//   slid RIGHT (编辑)    → drop it into the composer to fix before sending
//
// This file DRAWS ONLY. The gesture, the dictation run and the draft all live in
// composer.tsx — which already owns the text these words are being written into,
// so putting the zone arithmetic anywhere else would mean two components
// agreeing about one string. Nothing here is interactive: the finger is still
// captured by the press layer over the textarea, so a button here could never
// receive its own click. The two pills are targets for HIT-TESTING (the composer
// reads their rects through the refs it passes in), not controls.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Mic, Pencil, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Where the finger is, and therefore what lifting it will do. */
export type HoldZone = 'send' | 'cancel' | 'edit';

/**
 * 'auth' — the mic isn't authorized yet, so this press asks instead of recording
 * (the grant has to be requested from the RELEASE; see composer.tsx).
 * 'listening' — a run is live. 'finishing' — released to send, waiting for the
 * last words (and the whole-passage correction) to land before they go out.
 */
export type HoldPhase = 'auth' | 'listening' | 'finishing';

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

  if (!mounted) return null;

  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  const hint =
    phase === 'auth'
      ? '松手 · 允许使用麦克风'
      : phase === 'finishing'
        ? '收尾中…'
        : zone === 'cancel'
          ? '松手 取消'
          : zone === 'edit'
            ? '松手 编辑'
            : '松手 发送';

  return createPortal(
    // pointer-events-none throughout: the press layer over the textarea holds
    // the pointer capture for this whole gesture, and an overlay that swallowed
    // events would only be able to steal them from it.
    <div className="pointer-events-none fixed inset-0 z-[120] flex flex-col bg-black/60 backdrop-blur-md">
      {/* The words, where you can read them — above the finger, not under it. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-end gap-3 px-6 pb-5">
        {phase !== 'auth' && (
          <div className="flex items-center gap-2 text-[11px] font-medium tabular-nums text-white/60">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                phase === 'finishing'
                  ? 'bg-white/40'
                  : zone === 'cancel'
                    ? 'bg-rose-400'
                    : 'animate-pulse bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]',
              )}
            />
            {mmss}
          </div>
        )}

        <div
          className={cn(
            'max-h-[42vh] max-w-[min(30rem,86vw)] overflow-hidden rounded-2xl px-4 py-3',
            'text-[15px] leading-relaxed transition-colors duration-150',
            zone === 'cancel'
              ? 'bg-white/20 text-white/50 line-through decoration-white/40'
              : 'bg-white text-neutral-900 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.7)]',
          )}
        >
          {phase === 'auth' ? (
            <span className="flex items-center gap-2 text-neutral-500">
              <Mic className="h-4 w-4" />
              需要麦克风权限才能说话
            </span>
          ) : text ? (
            // The tail is what just arrived, so the box shows its END.
            <span className="block max-h-[42vh] overflow-hidden whitespace-pre-wrap break-words [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:8]">
              {text}
            </span>
          ) : (
            <span className="flex items-center gap-2 text-neutral-400">
              <Mic className="h-4 w-4" />
              在听…
            </span>
          )}
        </div>

        <div
          className={cn(
            'flex items-center gap-1.5 text-[13px] font-medium transition-colors duration-150',
            zone === 'cancel' && phase === 'listening' ? 'text-rose-300' : 'text-white/75',
          )}
        >
          {phase === 'finishing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {hint}
        </div>
      </div>

      {/* The two targets, at the bottom corners where the thumb already is —
          slide onto one and lifting means that instead of "send". They keep
          their shape off the screen edges on purpose: the whole corner is the
          target, so a slide that overshoots still lands. */}
      <div className="relative h-[168px] shrink-0 overflow-hidden">
        <Pill
          pillRef={cancelRef}
          side="left"
          active={zone === 'cancel' && phase === 'listening'}
          icon={<X className="h-[18px] w-[18px]" />}
          label="取消"
        />
        <Pill
          pillRef={editRef}
          side="right"
          active={zone === 'edit' && phase === 'listening'}
          icon={<Pencil className="h-[18px] w-[18px]" />}
          label="编辑"
        />
      </div>
    </div>,
    document.body,
  );
}

function Pill({
  pillRef,
  side,
  active,
  icon,
  label,
}: {
  pillRef: React.RefObject<HTMLDivElement | null>;
  side: 'left' | 'right';
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div
      ref={pillRef}
      className={cn(
        'absolute bottom-[-40px] flex h-[190px] w-[52%] flex-col items-center gap-1.5 pt-7',
        'rounded-[96px] transition-colors duration-150',
        side === 'left' ? 'left-[-8%]' : 'right-[-8%]',
        active ? 'bg-white text-neutral-900' : 'bg-white/12 text-white/70',
      )}
    >
      {icon}
      <span className="text-[12px] font-medium">{label}</span>
    </div>
  );
}
