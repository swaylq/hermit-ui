// 5-hour block + weekly snapshot. ccusage's `blocks` view is the Anthropic
// 5-hour billing window; `weekly` view aggregates Mon-Sun ISO weeks.

import { execCapture } from '../exec';

// The two views name the same four counters differently — `blocks` nests them under
// `tokenCounts` with an `…InputTokens` suffix, `weekly` puts them flat on the row —
// so each is normalised through `split()` below.
type TokenSplit = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};
type Block = {
  id: string;
  startTime: string;
  endTime: string;
  costUSD: number;
  totalTokens: number;
  isActive: boolean;
  isGap: boolean;
  tokenCounts?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
};
type WeeklyRow = {
  period: string; // e.g. "2026-W21"
  totalCost: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

const ZERO_SPLIT: TokenSplit = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

function blockSplit(b: Block): TokenSplit {
  const t = b.tokenCounts;
  if (!t) return ZERO_SPLIT;
  return {
    inputTokens: t.inputTokens ?? 0,
    outputTokens: t.outputTokens ?? 0,
    cacheCreationTokens: t.cacheCreationInputTokens ?? 0,
    cacheReadTokens: t.cacheReadInputTokens ?? 0,
  };
}

function weeklySplit(w: WeeklyRow): TokenSplit {
  return {
    inputTokens: w.inputTokens ?? 0,
    outputTokens: w.outputTokens ?? 0,
    cacheCreationTokens: w.cacheCreationTokens ?? 0,
    cacheReadTokens: w.cacheReadTokens ?? 0,
  };
}

async function runCcusage(view: 'blocks' | 'weekly', extraArgs: string[] = []): Promise<any> {
  // Async spawn so the 5h/weekly ccusage scans don't freeze the event loop.
  const r = await execCapture('npx', ['--yes', 'ccusage', view, '--json', ...extraArgs], {
    timeoutMs: 90_000,
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export type WindowRow = TokenSplit & {
  kind: 'fiveHour' | 'weekly';
  startTime: string;
  endTime: string;
  costUSD: number;
  totalTokens: number;
  isActive: boolean;
};

export async function collectUsageWindows(): Promise<WindowRow[]> {
  const out: WindowRow[] = [];

  // Active 5h block.
  const blocksPayload = await runCcusage('blocks');
  if (blocksPayload?.blocks?.length) {
    const blocks: Block[] = blocksPayload.blocks;
    const active = blocks.find((b) => b.isActive && !b.isGap);
    if (active) {
      out.push({
        kind: 'fiveHour',
        startTime: active.startTime,
        endTime: active.endTime,
        costUSD: active.costUSD,
        totalTokens: active.totalTokens,
        ...blockSplit(active),
        isActive: true,
      });
    } else {
      // No active block right now — surface the most recent finished one so
      // the UI still shows something; mark isActive=false so callers know.
      const recent = [...blocks].reverse().find((b) => !b.isGap);
      if (recent) {
        out.push({
          kind: 'fiveHour',
          startTime: recent.startTime,
          endTime: recent.endTime,
          costUSD: recent.costUSD,
          totalTokens: recent.totalTokens,
          ...blockSplit(recent),
          isActive: false,
        });
      }
    }
  }

  // Current weekly bucket. ccusage weekly keys each entry by the Monday date
  // of that week (e.g. "2026-05-18"). Match by computing this week's Monday.
  const { startTime, endTime, mondayKey } = weekRange(new Date());
  const weeklyPayload = await runCcusage('weekly');
  if (weeklyPayload?.weekly?.length) {
    const weekly: WeeklyRow[] = weeklyPayload.weekly;
    const cur = weekly.find((w) => w.period === mondayKey);
    if (cur) {
      out.push({
        kind: 'weekly',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        costUSD: cur.totalCost,
        totalTokens: cur.totalTokens ?? 0,
        ...weeklySplit(cur),
        isActive: true,
      });
    }
  }

  return out;
}

function weekRange(d: Date): { startTime: Date; endTime: Date; mondayKey: string } {
  // Monday 00:00 UTC → Sunday 23:59:59.999 UTC. Key = Monday's YYYY-MM-DD.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() - (dow - 1));
  tmp.setUTCHours(0, 0, 0, 0);
  const startTime = new Date(tmp);
  const endTime = new Date(tmp);
  endTime.setUTCDate(endTime.getUTCDate() + 7);
  endTime.setUTCMilliseconds(endTime.getUTCMilliseconds() - 1);
  const mondayKey = startTime.toISOString().slice(0, 10);
  return { startTime, endTime, mondayKey };
}
