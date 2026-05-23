'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';

export function TaskDetailSheet({
  open,
  onOpenChange,
  label,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  label: string | null;
}) {
  const query = trpc.tasks.tailLog.useQuery(
    { label: label ?? '', lines: 300 },
    { enabled: !!label && open, refetchInterval: open ? 5000 : false },
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col gap-0 p-0">
        <SheetHeader className="border-b">
          <SheetTitle className="font-mono text-sm">{label ?? '—'}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {query.data?.logPath ?? 'no log path on this LaunchAgent'}
          </SheetDescription>
        </SheetHeader>

        {query.isPending && (
          <div className="p-4">
            <Skeleton className="h-[60vh]" />
          </div>
        )}

        {query.data && (
          <ScrollArea className="flex-1">
            <pre className="text-xs font-mono p-4 whitespace-pre-wrap break-all text-foreground/90">
              {query.data.tail || '(empty log)'}
            </pre>
          </ScrollArea>
        )}

        {query.error && <p className="p-4 text-sm text-rose-400">error: {query.error.message}</p>}
      </SheetContent>
    </Sheet>
  );
}
