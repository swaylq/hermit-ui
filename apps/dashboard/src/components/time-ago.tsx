'use client';

import { useEffect, useState } from 'react';
import { relTime } from '@/lib/format';

// One app-wide ticker drives every <TimeAgo>, so "Ns ago" stays live instead of
// freezing at first render — the chat's MessageRow is memo'd, so a bare relTime()
// call there never recomputes until the row's props change, leaving timestamps
// stuck. A single shared interval + a module-level subscriber set keeps this to
// ONE timer regardless of how many timestamps are mounted; the timer is torn down
// when the last <TimeAgo> unmounts.
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (timer === null && typeof window !== 'undefined') {
    timer = setInterval(() => {
      for (const f of subscribers) f();
    }, 5_000);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function TimeAgo({
  date,
  className,
}: {
  date: Date | string | null | undefined;
  className?: string;
}) {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return <span className={className}>{relTime(date)}</span>;
}
