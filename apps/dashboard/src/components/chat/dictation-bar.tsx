'use client';

// The dictation bar — the controls for a running dictation, above the composer.
//
// It does NOT hold the transcript. The words — partial included, the one the ASR
// keeps rewriting as it hears more ("发" → "发 red hot" → "把Red Hole的隧道重启")
// — go straight into the composer, so you watch them appear where you are going
// to send them and the self-correction happens in place.
//
// What is left here is everything that is about the RUN rather than the text: a
// recording indicator, the live level, how long you have been talking, how many
// sentences are still being corrected behind you, and the two ways out.

import { memo } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { VoiceWave } from '@/components/chat/voice-wave';
import { cn } from '@/lib/utils';

export type DictationStatus = 'connecting' | 'listening' | 'finishing' | 'error';


export const DictationBar = memo(function DictationBar({
  pending,
  level,
  silent,
  status,
  elapsedMs,
  hint,
  onDone,
  onCancel,
}: {
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
  // user ends up talking to a socket that never opened. `silent` is the capture
  // gate: quiet long enough that we stopped streaming, which is also the state
  // where nothing is going to appear no matter how long you stare at the box.
  const label =
    status === 'connecting' ? '接通中…'
    : status === 'finishing' ? '收尾中…'
    : status === 'error' ? (hint ?? '出错了')
    : silent ? '在听…'
    : '正在识别';

  return (
    // Same container as the composer below it (mx-auto / max-w-3xl / px-3) so the
    // two read as one stack rather than a banner pasted over the page.
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-1.5">
    <div
      className="relative flex items-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-[#111319]/90 px-2.5 py-2 backdrop-blur-xl"
      style={{ boxShadow: '0 8px 28px -10px rgba(79,123,255,0.45), 0 2px 10px -2px rgba(0,0,0,0.5)' }}
    >
      {/* The aurora, dimmed right down — this bar is for reading text, so the
          wave is a level indicator behind it, not the main event. */}
      <div className="pointer-events-none absolute inset-0 opacity-30">
        <VoiceWave phase={status === 'error' ? 'error' : status === 'finishing' ? 'transcribing' : 'recording'} level={level} />
      </div>

      <span
        className={cn(
          'relative z-10 h-2 w-2 shrink-0 rounded-full',
          status === 'error' ? 'bg-rose-400'
            : silent || status !== 'listening' ? 'bg-white/40'
            : 'animate-pulse bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]',
        )}
      />

      <div className="relative z-10 min-w-0 flex-1">
        <div className={cn('truncate text-[13px] leading-5', status === 'error' ? 'text-rose-200' : 'text-white/45')}>
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

      <span className="relative z-10 shrink-0 text-[11px] font-medium tabular-nums text-white/70">
        {mmss}
      </span>

      <button
        type="button"
        onClick={onCancel}
        aria-label="取消这次听写"
        className="relative z-10 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onDone}
        disabled={status === 'finishing'}
        aria-label="结束听写"
        className="relative z-10 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22 disabled:cursor-default disabled:opacity-60"
      >
        {status === 'finishing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
      </button>
    </div>
    </div>
  );
});
