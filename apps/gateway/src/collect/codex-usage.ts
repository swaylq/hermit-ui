// collect/codex-usage.ts — what codex has spent, read from codex's own files.
//
// There is no `codex usage` command, and unlike Claude there is no TUI panel to
// scrape either. But every turn codex writes a `token_count` event into its
// rollout JSONL carrying BOTH a running token total and the server's own
// `rate_limits` block — the same numbers the CLI shows. So this reads them
// rather than estimating anything.
//
// Two different questions, two different sources, deliberately:
//   · "how much of the plan is gone" -> rate_limits, from the NEWEST rollout
//     only. It is a server-reported figure about the account, so the most
//     recent turn has the freshest copy and older files say nothing extra.
//   · "how much did each day cost" -> per-day token totals, summed across the
//     rollouts of the last N days.
//
// Cost control matters here: a long-lived machine accumulates thousands of
// rollouts and some run to megabytes. Only the last DAILY_DAYS date directories
// are walked, and only the TAIL of each file is read — the running total is
// cumulative, so the last token_count in a file is the whole answer for it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodexDailyUsage = {
  /** YYYY-MM-DD, as codex's own directory layout names it. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
};

export type CodexUsageSample = {
  usedPercent: number | null;
  /** 10080 means the percentage above is a WEEKLY figure. */
  windowMinutes: number | null;
  resetsAt: string | null;
  planType: string | null;
  daily: CodexDailyUsage[];
  capturedAt: string;
};

/** How many date directories back to sum. Two weeks fits the sparkline. */
const DAILY_DAYS = 14;

/** Enough tail to hold the last few JSONL records of any rollout. */
const TAIL_BYTES = 256 * 1024;

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The newest date directories, newest first, as `[path, 'YYYY-MM-DD']`. */
export function recentDayDirs(home = codexHome(), limit = DAILY_DAYS): Array<[string, string]> {
  const root = path.join(home, 'sessions');
  const out: Array<[string, string]> = [];
  for (const y of readdirSafe(root)) {
    for (const m of readdirSafe(path.join(root, y))) {
      for (const d of readdirSafe(path.join(root, y, m))) {
        out.push([path.join(root, y, m, d), `${y}-${m}-${d}`]);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** The tail of a file, or '' if it cannot be read. */
function tail(file: string): string {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

type TokenCount = {
  total: { input: number; output: number } | null;
  limits: {
    usedPercent: number | null;
    windowMinutes: number | null;
    resetsAt: string | null;
    planType: string | null;
  } | null;
};

/**
 * The last token_count record in a rollout's tail.
 *
 * Both halves are optional: an old rollout may predate `rate_limits`, and a
 * session killed before its first turn has no totals at all. Returning them
 * separately lets the caller take whichever it actually found.
 */
export function lastTokenCount(text: string): TokenCount {
  const lines = text.split('\n');
  let total: TokenCount['total'] = null;
  let limits: TokenCount['limits'] = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('token_count')) continue;
    let payload: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(line) as { payload?: Record<string, unknown> };
      payload = parsed?.payload ?? (parsed as Record<string, unknown>);
    } catch {
      continue; // the tail cut mid-record, or a shape we do not know
    }
    const info = payload?.info as { total_token_usage?: Record<string, number> } | undefined;
    const t = info?.total_token_usage;
    if (t && !total) {
      total = { input: Number(t.input_tokens ?? 0), output: Number(t.output_tokens ?? 0) };
    }
    const rl = payload?.rate_limits as {
      primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
      plan_type?: string;
    } | undefined;
    if (rl?.primary && !limits) {
      const p = rl.primary;
      limits = {
        usedPercent: typeof p.used_percent === 'number' ? p.used_percent : null,
        windowMinutes: typeof p.window_minutes === 'number' ? p.window_minutes : null,
        // codex writes epoch SECONDS; Date wants ms. Getting this wrong puts
        // the reset in 1970 and the countdown renders as long past.
        resetsAt: typeof p.resets_at === 'number' ? new Date(p.resets_at * 1000).toISOString() : null,
        planType: typeof rl.plan_type === 'string' ? rl.plan_type : null,
      };
    }
    if (total && limits) break;
  }
  return { total, limits };
}

/**
 * Collect this machine's codex usage, or null when codex has never run here.
 *
 * Null rather than a zeroed sample on purpose: "no codex on this machine" and
 * "codex used nothing this week" are different facts, and the dashboard hides
 * the section for the first while showing 0% for the second.
 */
export function collectCodexUsage(home = codexHome()): CodexUsageSample | null {
  const days = recentDayDirs(home);
  if (days.length === 0) return null;

  const daily: CodexDailyUsage[] = [];
  let limits: TokenCount['limits'] = null;

  for (const [dir, day] of days) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    // Newest first within the day, so the rate limits come from the most recent
    // turn overall — days are already walked newest-first.
    files.sort().reverse();

    let inputTokens = 0;
    let outputTokens = 0;
    let sessions = 0;
    for (const f of files) {
      const { total, limits: l } = lastTokenCount(tail(path.join(dir, f)));
      if (l && !limits) limits = l;
      if (!total) continue;
      inputTokens += total.input;
      outputTokens += total.output;
      sessions += 1;
    }
    if (sessions > 0) daily.push({ day, inputTokens, outputTokens, sessions });
  }

  if (daily.length === 0 && !limits) return null;

  return {
    usedPercent: limits?.usedPercent ?? null,
    windowMinutes: limits?.windowMinutes ?? null,
    resetsAt: limits?.resetsAt ?? null,
    planType: limits?.planType ?? null,
    // Oldest first, which is the order a chart wants to draw.
    daily: daily.reverse(),
    capturedAt: new Date().toISOString(),
  };
}
