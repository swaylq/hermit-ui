'use client';

import { cn } from '@/lib/utils';
import { PixelCrab } from '@/components/pixel-crab';

// The Hermit brand mark: the pixel-art hermit crab + "Hermit" wordmark, with an
// optional emerald "alive" dot.
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
      <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <PixelCrab className="h-5 w-5" />
        {alive && (
          <span
            aria-hidden
            className="absolute -right-px -top-px h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-background"
          />
        )}
      </span>
      {showWordmark && (
        <span className="hidden sm:inline font-semibold tracking-tight text-[14px] text-foreground">
          Hermit
        </span>
      )}
    </span>
  );
}
