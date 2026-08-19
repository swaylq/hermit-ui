'use client';

// The dictation bar — where the UNSTABLE half of realtime voice input lives.
//
// Sits directly above the composer while a dictation run is going. It holds the
// partial transcript: the sentence currently being spoken, which the ASR rewrites
// wholesale every few hundred milliseconds as it hears more ("发" → "发 red hot"
// → "把Red Hole的隧道重启"). That self-correction is the good part, so it is shown
// raw rather than smoothed.
//
// It is a bar and not the textarea for two concrete reasons: a <textarea> cannot
// style a substring, so there would be no way to say "these characters are still
// moving"; and rewriting the draft four times a second fights the user's caret.
// This is how an IME has always drawn its preedit string — unstable text stays
// outside the document until it commits. The moment a sentence closes it leaves
// this bar and lands in the draft for real.

import { memo } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { VoiceWave } from '@/components/chat/voice-wave';
import { cn } from '@/lib/utils';

export type DictationStatus = 'connecting' | 'listening' | 'finishing' | 'error';

/** How much of a long partial stays on screen (the end of it). */
const PREEDIT_CHARS = 64;

function tailOf(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

export const DictationBar = memo(function DictationBar({
  partial,
  pending,
  level,
  silent,
  status,
  elapsedMs,
  hint,
  onDone,
  onCancel,
}: {
  partial: string;
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

  // What the middle of the bar says when there is no partial to show. Each of
  // these is a different thing happening, and conflating them is how a user ends
  // up talking to a socket that never opened.
  const idleLabel =
    status === 'connecting' ? '接通中…'
    : status === 'finishing' ? '收尾中…'
    : status === 'error' ? (hint ?? '出错了')
    : silent ? '在听…'
    : '说吧';

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

      {/* Preedit. Dim + italic says "not committed yet". A long partial is shown
          from its END — the words are appearing on the right, and watching the
          beginning of a sentence you finished saying is useless. */}
      <div className="relative z-10 min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-[13px] leading-5',
            partial ? 'text-white/60 italic' : 'text-white/35',
          )}
        >
          {partial ? tailOf(partial, PREEDIT_CHARS) : idleLabel}
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
