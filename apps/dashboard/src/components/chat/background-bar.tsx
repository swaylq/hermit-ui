'use client';

// One quiet line above the suggestion chips: what is still running in the
// background after the reply ended.
//
// sway, 2026-09-03, on the first version (a bordered box with a header and a
// row per task): "ui 只走一行，在 suggestion 的上方，尽量小和隐蔽". So: one
// truncated line, muted, no box — the oldest task's description, its last
// output line when the gateway has one, its age, and "×N" when there are more.
// The full list stays in the session detail sheet; hover shows it here.
//
// Reads the same `activity` blob as the header chip, so the two cannot disagree
// about whether anything is running. Renders nothing at all when nothing is.

import { Collapse } from '@/components/chat/collapse';
import { backgroundOutstanding, backgroundTaskList, shortDuration } from '@/lib/session-status';

export function BackgroundBar({ activity }: { activity: unknown }) {
  const open = backgroundOutstanding(activity);
  const tasks = open ? backgroundTaskList(activity) : [];
  const first = tasks[0];
  const count = tasks.length;
  const text = first
    ? `${first.kind === 'subagent' ? '子 agent：' : ''}${first.description}` +
      (first.outputTail ? ` — ${first.outputTail}` : '') +
      (first.elapsedSec ? ` · ${shortDuration(first.elapsedSec)}` : '')
    : '网关还没报是哪些任务';
  const title = tasks.length
    ? tasks.map((t) => `${t.elapsedSec ? shortDuration(t.elapsedSec) : '—'}  ${t.description}${t.command ? `\n    ${t.command}` : ''}`).join('\n')
    : undefined;
  return (
    <Collapse open={open} className="mx-auto w-full max-w-3xl px-3">
      <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] leading-4 text-muted-foreground/70 min-w-0" title={title}>
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/50" aria-hidden />
        <span className="truncate">
          后台{count > 1 ? ` ×${count}` : ''} · {text}
        </span>
      </div>
    </Collapse>
  );
}
