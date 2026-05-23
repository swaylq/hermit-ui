'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { relTime } from '@/lib/format';

type Task = {
  id: string;
  label: string;
  scheduleKind: string | null;
  lastFire: Date | string | null;
  logPath: string | null;
  keepAlive: boolean;
  running: boolean | null;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
};

const statusStyle: Record<Task['status'], { text: string; bg: string }> = {
  ok: { text: 'text-emerald-300', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  warn: { text: 'text-amber-300', bg: 'bg-amber-400/15 border-amber-400/30' },
  fail: { text: 'text-rose-300', bg: 'bg-rose-500/15 border-rose-500/30' },
  unknown: { text: 'text-zinc-400', bg: 'bg-zinc-700/30 border-zinc-700' },
};

export function TasksTable({ tasks, onSelect }: { tasks: Task[]; onSelect: (label: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>label</TableHead>
          <TableHead>schedule</TableHead>
          <TableHead>status</TableHead>
          <TableHead>last fire</TableHead>
          <TableHead className="text-right">log</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.map((t) => {
          const short = t.label.replace(/^ai\.(claudeclaw|openclaw)\./, '');
          const stat = statusStyle[t.status];
          return (
            <TableRow key={t.id} onClick={() => onSelect(t.label)} className="cursor-pointer">
              <TableCell className="font-mono text-xs">{short}</TableCell>
              <TableCell className="text-xs font-mono text-muted-foreground">{t.scheduleKind ?? '-'}</TableCell>
              <TableCell>
                <Badge variant="outline" className={`${stat.text} ${stat.bg} font-mono text-[10px]`}>
                  {t.keepAlive ? (t.running ? 'up' : 'down') : t.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs font-mono text-muted-foreground">{relTime(t.lastFire)}</TableCell>
              <TableCell className="text-xs font-mono text-right text-muted-foreground/80">
                {t.logPath ? t.logPath.split('/').pop() : '-'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
