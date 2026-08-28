'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Height+opacity collapse for the conditional bars around the composer (queue,
// takeover, dictation, find): the grid-template-rows 0fr→1fr trick animates an
// auto-height child without measuring it. Enter mounts at 0fr and flips to 1fr
// on the next frame; on close the child stays mounted for the leave window
// (matches duration-200) so both directions animate. Same controlled-show
// pattern as overlay.tsx.
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(r);
    }
    setShow(false);
    const t = window.setTimeout(() => setMounted(false), 200);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
        show ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
