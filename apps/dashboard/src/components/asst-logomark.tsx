'use client';

import { cn } from '@/lib/utils';

export function AsstLogomark({
  className,
  showWordmark = true,
  alive = true,
}: {
  className?: string;
  showWordmark?: boolean;
  alive?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 leading-none', className)}>
      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-foreground">
        <span
          aria-hidden
          className="text-background text-[11px] font-semibold leading-none"
        >
          a
        </span>
        {alive && (
          <span
            aria-hidden
            className="absolute -right-px -top-px h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-background"
          />
        )}
      </span>
      {showWordmark && (
        <span className="hidden sm:inline font-semibold tracking-tight text-[14px] text-foreground">
          asst
        </span>
      )}
    </span>
  );
}
