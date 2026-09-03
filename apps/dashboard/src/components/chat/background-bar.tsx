'use client';

// The strip above the composer that says what a session's background tasks are
// DOING while the reply is already over.
//
// Before this, "background" was a word on the status chip and a list two taps
// away in the detail sheet. sway, 2026-09-03: "让用户可以看到 background 在做什么"
// — so each task is named where the eyes already are, with its age and the last
// line it wrote (the gateway tails the task's output file; a subagent has no
// tail, its output is a transcript).
//
// Reads the same `activity` blob as the header chip, so the two cannot disagree
// about whether anything is running. Shows nothing at all when nothing is.

import { Collapse } from '@/components/chat/collapse';
import { backgroundOutstanding, backgroundTaskList, shortDuration } from '@/lib/session-status';

const SHOW_MAX = 4;

export function BackgroundBar({ activity }: { activity: unknown }) {
  const open = backgroundOutstanding(activity);
  const tasks = open ? backgroundTaskList(activity) : [];
  const shown = tasks.slice(0, SHOW_MAX);
  return (
    <Collapse open={open} className="mx-auto w-full max-w-3xl px-3">
      <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between text-muted-foreground">
          <span>
            回复已结束，{tasks.length ? `${tasks.length} 个` : ''}后台任务还在跑 · 跑完 agent 会再回一条
          </span>
        </div>
        {shown.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {shown.map((t) => (
              <li key={t.id} className="flex items-start gap-2 min-w-0" title={t.command ?? t.description}>
                <span className="w-14 shrink-0 pt-px font-mono text-[11px] tabular-nums text-muted-foreground">
                  {t.elapsedSec ? shortDuration(t.elapsedSec) : '—'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground/90">
                    {t.kind === 'subagent' ? '子 agent · ' : ''}
                    {t.description}
                  </span>
                  {t.outputTail && (
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{t.outputTail}</span>
                  )}
                </span>
              </li>
            ))}
            {tasks.length > SHOW_MAX && (
              <li className="text-muted-foreground">…还有 {tasks.length - SHOW_MAX} 个</li>
            )}
          </ul>
        ) : (
          <div className="text-muted-foreground">这台机器的网关还没报是哪些任务</div>
        )}
      </div>
    </Collapse>
  );
}
