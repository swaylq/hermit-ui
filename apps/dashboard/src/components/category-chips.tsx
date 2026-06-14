'use client';

import { cn } from '@/lib/utils';

// A horizontal, scrollable group/category filter shared by the market skills page
// and the install picker. value '' = 全部 (no filter). Renders nothing when there
// are no groups yet, so ungrouped marketplaces stay clean.
export function CategoryChips({
  cats,
  value,
  onChange,
  className,
}: {
  cats: string[];
  value: string;
  onChange: (c: string) => void;
  className?: string;
}) {
  if (cats.length === 0) return null;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {['', ...cats].map((c) => (
        <button
          key={c || '__all__'}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            'shrink-0 rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap transition-colors cursor-pointer',
            value === c
              ? 'border-foreground/30 bg-accent text-foreground font-medium'
              : 'border-border text-muted-foreground hover:bg-accent/50',
          )}
        >
          {c || '全部'}
        </button>
      ))}
    </div>
  );
}
