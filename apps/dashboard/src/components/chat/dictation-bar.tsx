'use client';

// The dictation bar — the controls and the state of a running dictation, above
// the composer.
//
// It does NOT hold the transcript. The words go straight into the composer,
// typed out a character at a time, so you watch them appear where you are going
// to send them and the ASR's self-correction happens in place.
//
// ✓ AND ✕ LIVE HERE, not only on the floating mic, because the mic is not always
// reachable. It is positioned against `window.innerHeight`, which on iOS does
// NOT shrink when the on-screen keyboard opens — so a mic parked near the bottom
// (the default) ends up behind the keyboard: invisible and untappable, which is
// exactly what people hit. This bar rides in the composer's own stack and moves
// with it, so a control here is always on screen.
//
// Both sit on the LEFT. The mic is draggable and this bar is not, so they can
// overlap, and the mic's default corner is bottom-RIGHT — leaving the clock as
// the only thing it can land on. Overlapping the clock is cosmetic; overlapping
// the way out of a recording is the bug this exists to fix.
//
// The mic still finishes a run too (release it, or tap it), and a held run can
// be cancelled without lifting a finger by sliding up off the button — the
// WeChat idiom, which is why the label says so in that mode.

import { memo } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { VoiceWave } from '@/components/chat/voice-wave';
import type { DictationSource } from '@/components/chat/dictation-dock';
import { cn } from '@/lib/utils';

// 'finishing' = the tail of the transcript is still arriving; 'refining' = it
// has all arrived and is being read through as one passage (the end-of-run
// pass in server/transcribe-refine.ts). The second one gets its own label
// because the words on screen are about to CHANGE, and a rewrite nobody
// announced reads as a glitch rather than a correction.
export type DictationStatus = 'connecting' | 'listening' | 'offline' | 'finishing' | 'refining' | 'error';

export const DictationBar = memo(function DictationBar({
  source,
  cancelArmed,
  pending,
  level,
  silent,
  status,
  elapsedMs,
  hint,
  onDone,
  onCancel,
}: {
  source: DictationSource;
  /** Releasing now throws the run away — the finger is covering the button, so say it here. */
  cancelArmed: boolean;
  /** Sentences still being corrected in the background. */
  pending: number;
  level: number;
  /** The silence gate is shut — we stopped streaming because nobody is talking. */
  silent: boolean;
  status: DictationStatus;
  elapsedMs: number;
  hint?: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const secs = Math.floor(elapsedMs / 1000);
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  // Each of these is a different thing happening, and conflating them is how a
  // user ends up talking to a socket that never opened. 'offline' is the one
  // worth spelling out: the words are being recorded and will arrive together
  // when you finish, rather than live.
  const label =
    cancelArmed ? '松开取消'
    : status === 'connecting' ? '接通中…'
    : status === 'finishing' ? '收尾中…'
    : status === 'refining' ? '通读整理中…'
    : status === 'error' ? (hint ?? '出错了')
    : status === 'offline' ? '实时转写不可用 · 正在录音，松开后转写'
    : silent ? '在听…'
    : source === 'hold' ? '正在识别 · 松手结束，上滑取消'
    : '正在识别';

  return (
    // Same container as the composer below it (mx-auto / max-w-3xl / px-3) so the
    // two read as one stack rather than a banner pasted over the page.
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-1.5">
      <div
        className="relative flex items-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-[#111319]/90 px-2.5 py-2 backdrop-blur-xl"
        style={{ boxShadow: '0 8px 28px -10px rgba(79,123,255,0.45), 0 2px 10px -2px rgba(0,0,0,0.5)' }}
      >
        {/* The aurora, dimmed right down — this bar is read, not watched, so the
            wave is a level indicator behind it rather than the main event. */}
        <div className="pointer-events-none absolute inset-0 opacity-30">
          <VoiceWave
            phase={status === 'error' ? 'error' : status === 'finishing' || status === 'refining' ? 'transcribing' : 'recording'}
            level={level}
          />
        </div>

        <button
          type="button"
          onClick={onCancel}
          aria-label="取消这次听写"
          className="relative z-10 -ml-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white active:bg-white/15"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={status === 'finishing' || status === 'refining'}
          aria-label="结束听写"
          className="relative z-10 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22 active:bg-white/28 disabled:cursor-default disabled:opacity-60"
        >
          {status === 'finishing' || status === 'refining'
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Check className="h-3.5 w-3.5" />}
        </button>

        <span
          className={cn(
            'relative z-10 h-2 w-2 shrink-0 rounded-full transition-colors',
            cancelArmed || status === 'error' ? 'bg-rose-400'
              : silent || status === 'connecting' || status === 'finishing' || status === 'refining' ? 'bg-white/40'
              : status === 'offline' ? 'bg-amber-400'
              : 'animate-pulse bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]',
          )}
        />

        <div className="relative z-10 min-w-0 flex-1">
          <div
            className={cn(
              'truncate text-[13px] leading-5 transition-colors',
              cancelArmed || status === 'error' ? 'text-rose-200' : status === 'offline' ? 'text-amber-200/80' : 'text-white/45',
            )}
          >
            {label}
          </div>
        </div>

        {pending > 0 && (
          <span
            className="relative z-10 shrink-0 text-[10px] tabular-nums text-sky-300/80"
            title={`${pending} 句正在校对`}
          >
            校对 {pending}
          </span>
        )}

        {/* Last, and the only thing the floating mic can land on. */}
        <span className="relative z-10 shrink-0 pr-9 text-[11px] font-medium tabular-nums text-white/70">
          {mmss}
        </span>
      </div>
    </div>
  );
});
