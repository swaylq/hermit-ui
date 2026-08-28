// collect/codex-usage.ts — Codex subscription limits plus recent token activity.
//
// Limits come from Codex's stable app-server `account/rateLimits/read` method.
// It returns every metered bucket in one current snapshot. Reading the newest
// rollout file was not equivalent: ordinary Codex reports a weekly bucket while
// GPT-5.3-Codex-Spark reports its own 5h + weekly bucket, so whichever model ran
// last made three identical machines show different cards.
//
// Token activity still comes from rollout JSONL. It is retained for the sync
// contract even though the Usage page no longer renders the old date chart.

import { spawn } from 'node:child_process';
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
  // Legacy single-window fields. Keep sending the ordinary weekly bucket so an
  // older dashboard remains useful while the fleet rolls forward.
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  fiveHourLimitId: string | null;
  fiveHourLimitName: string | null;
  weekPct: number | null;
  weekResetsAt: string | null;
  weekLimitId: string | null;
  weekLimitName: string | null;
  planType: string | null;
  daily: CodexDailyUsage[];
  capturedAt: string;
};

type RawWindow = {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type RawBucket = {
  limitId: string;
  limitName: string | null;
  planType: string | null;
  primary: RawWindow | null;
  secondary: RawWindow | null;
};

export type SelectedCodexWindow = {
  usedPercent: number | null;
  windowMinutes: number;
  resetsAt: string | null;
  limitId: string;
  limitName: string | null;
};

export type SelectedCodexLimits = {
  fiveHour: SelectedCodexWindow | null;
  weekly: SelectedCodexWindow | null;
  planType: string | null;
};

export type CodexAppServerOptions = {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  stopGraceMs?: number;
};

/** How many active date directories back to sum. */
const DAILY_DAYS = 14;

/** Enough tail to hold the last few JSONL records of any rollout. */
const TAIL_BYTES = 256 * 1024;

const APP_SERVER_TIMEOUT_MS = 12_000;
const APP_SERVER_STOP_GRACE_MS = 150;

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The newest active date directories, newest first, as `[path, YYYY-MM-DD]`. */
export function recentDayDirs(home = codexHome(), limit = DAILY_DAYS): Array<[string, string]> {
  const root = path.join(home, 'sessions');
  const out: Array<[string, string]> = [];
  for (const year of readdirSafe(root)) {
    for (const month of readdirSafe(path.join(root, year))) {
      for (const day of readdirSafe(path.join(root, year, month))) {
        out.push([path.join(root, year, month, day), `${year}-${month}-${day}`]);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** The tail of a file, or an empty string if it cannot be read. */
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

/** The last cumulative token total in one rollout tail. */
export function lastTokenCount(text: string): { input: number; output: number } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('token_count')) continue;
    try {
      const parsed = JSON.parse(line) as { payload?: Record<string, unknown> };
      const payload = parsed?.payload ?? (parsed as Record<string, unknown>);
      const info = payload?.info as { total_token_usage?: Record<string, number> } | undefined;
      const total = info?.total_token_usage;
      if (total) {
        return {
          input: Number(total.input_tokens ?? 0),
          output: Number(total.output_tokens ?? 0),
        };
      }
    } catch {
      // The tail can begin halfway through a record. Keep walking backwards.
    }
  }
  return null;
}

function collectDaily(home: string): CodexDailyUsage[] {
  const daily: CodexDailyUsage[] = [];
  for (const [dir, day] of recentDayDirs(home)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((file) => file.startsWith('rollout-') && file.endsWith('.jsonl'));
    } catch {
      continue;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let sessions = 0;
    for (const file of files) {
      const total = lastTokenCount(tail(path.join(dir, file)));
      if (!total) continue;
      inputTokens += total.input;
      outputTokens += total.output;
      sessions += 1;
    }
    if (sessions > 0) daily.push({ day, inputTokens, outputTokens, sessions });
  }
  return daily.reverse();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseWindow(value: unknown): RawWindow | null {
  const raw = record(value);
  if (!raw) return null;
  const usedPercent = nullableNumber(raw.usedPercent);
  const windowDurationMins = nullableNumber(raw.windowDurationMins);
  // A duration alone is metadata, not a quota reading. Reject it so a partial
  // app-server response cannot overwrite the database's last good percentage.
  // Zero is intentionally valid.
  if (usedPercent == null || windowDurationMins == null) return null;
  return {
    usedPercent,
    windowDurationMins,
    resetsAt: nullableNumber(raw.resetsAt),
  };
}

function parseBucket(value: unknown, fallbackId?: string): RawBucket | null {
  const raw = record(value);
  if (!raw) return null;
  const limitId = nullableString(raw.limitId) ?? fallbackId ?? null;
  if (!limitId) return null;
  return {
    limitId,
    limitName: nullableString(raw.limitName),
    planType: nullableString(raw.planType),
    primary: parseWindow(raw.primary),
    secondary: parseWindow(raw.secondary),
  };
}

function windowsOf(bucket: RawBucket | null): RawWindow[] {
  return bucket ? [bucket.primary, bucket.secondary].filter((window): window is RawWindow => window != null) : [];
}

function selectedWindow(bucket: RawBucket, window: RawWindow): SelectedCodexWindow {
  const reset = window.resetsAt == null ? null : new Date(window.resetsAt * 1000);
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins ?? 0,
    // Date#toISOString throws on an out-of-range epoch. A malformed reset must
    // not turn an otherwise valid percentage into a 12-second probe timeout.
    resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null,
    limitId: bucket.limitId,
    limitName: bucket.limitName,
  };
}

/**
 * Pick the two values the product asks to display while keeping their source
 * buckets explicit. Today ordinary `codex` supplies weekly and Spark supplies
 * a separate 5-hour limit. If ordinary Codex later supplies both, it wins both.
 */
export function selectCodexLimits(result: unknown): SelectedCodexLimits | null {
  const raw = record(result);
  if (!raw) return null;

  const defaultBucket = parseBucket(raw.rateLimits);
  const bucketMap = record(raw.rateLimitsByLimitId);
  const buckets = bucketMap
    ? Object.entries(bucketMap)
        .map(([limitId, value]) => parseBucket(value, limitId))
        .filter((bucket): bucket is RawBucket => bucket != null)
    : [];
  if (defaultBucket && !buckets.some((bucket) => bucket.limitId === defaultBucket.limitId)) {
    buckets.push(defaultBucket);
  }
  if (buckets.length === 0) return null;

  const general = buckets.find((bucket) => bucket.limitId === 'codex') ?? defaultBucket ?? buckets[0];
  const spark = buckets.find((bucket) => bucket.limitId === 'codex_bengalfox') ?? null;
  const findWindow = (bucket: RawBucket | null, minutes: number) =>
    windowsOf(bucket).find((window) => window.windowDurationMins === minutes) ?? null;
  const findAnywhere = (minutes: number) => {
    for (const bucket of buckets) {
      const window = findWindow(bucket, minutes);
      if (window) return { bucket, window };
    }
    return null;
  };

  const generalFiveHour = findWindow(general, 300);
  const sparkFiveHour = findWindow(spark, 300);
  const anyFiveHour = findAnywhere(300);
  const fiveHour = generalFiveHour
    ? selectedWindow(general, generalFiveHour)
    : spark && sparkFiveHour
      ? selectedWindow(spark, sparkFiveHour)
      : anyFiveHour
        ? selectedWindow(anyFiveHour.bucket, anyFiveHour.window)
        : null;

  const generalWeekly = findWindow(general, 10_080);
  const sameBucketAsFiveHour = fiveHour
    ? buckets.find((bucket) => bucket.limitId === fiveHour.limitId) ?? null
    : null;
  const pairedWeekly = findWindow(sameBucketAsFiveHour, 10_080);
  const anyWeekly = findAnywhere(10_080);
  const weekly = generalWeekly
    ? selectedWindow(general, generalWeekly)
    : sameBucketAsFiveHour && pairedWeekly
      ? selectedWindow(sameBucketAsFiveHour, pairedWeekly)
      : anyWeekly
        ? selectedWindow(anyWeekly.bucket, anyWeekly.window)
        : null;

  if (!fiveHour && !weekly) return null;

  return {
    fiveHour,
    weekly,
    planType: general.planType ?? sameBucketAsFiveHour?.planType ?? buckets.find((bucket) => bucket.planType)?.planType ?? null,
  };
}

/**
 * Read all current ChatGPT limit buckets through a short-lived Codex app-server.
 * No thread or model turn is created. Every exit path stops exactly the child
 * this call spawned; a timeout never searches for or touches another process.
 */
export async function readCodexLimits(options: CodexAppServerOptions = {}): Promise<SelectedCodexLimits | null> {
  const command = (options.command ?? process.env.HERMIT_CODEX_BIN?.trim()) || 'codex';
  const args = options.args ?? ['app-server'];
  const timeoutMs = options.timeoutMs ?? APP_SERVER_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? APP_SERVER_STOP_GRACE_MS;

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let completing = false;
    let resolved = false;
    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const finishResolve = (value: SelectedCodexLimits | null) => {
      if (resolved) return;
      resolved = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(value);
    };

    let watchdog: NodeJS.Timeout;
    const stop = (value: SelectedCodexLimits | null, graceful: boolean) => {
      if (completing) return;
      completing = true;
      clearTimeout(watchdog);

      child.once('exit', () => finishResolve(value));
      if (child.exitCode != null || child.signalCode != null) {
        finishResolve(value);
        return;
      }

      if (graceful) {
        child.stdin.end();
        termTimer = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
        }, stopGraceMs);
      } else {
        child.stdin.destroy();
        child.kill('SIGTERM');
      }
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      }, stopGraceMs + 500);
    };

    watchdog = setTimeout(() => stop(null, false), timeoutMs);

    const send = (message: unknown) => {
      if (!completing && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const onMessage = (message: unknown) => {
      const msg = record(message);
      if (!msg) return;
      if (msg.id === 0) {
        if (msg.error || !msg.result) {
          stop(null, false);
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 6 });
      } else if (msg.id === 6) {
        stop(msg.error ? null : selectCodexLimits(msg.result), true);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          try {
            onMessage(JSON.parse(line));
          } catch {
            // App-server stdout is JSONL. Ignore one malformed line and wait for
            // the response id; the watchdog bounds a permanently broken stream.
          }
        }
        newline = stdout.indexOf('\n');
      }
    });
    child.on('error', () => stop(null, false));
    child.on('exit', () => {
      if (!completing) stop(null, false);
    });
    child.stdin.on('error', () => {
      if (!completing) stop(null, false);
    });

    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'hermit_usage_probe',
          title: 'Hermit Usage Probe',
          version: '0.1.0',
        },
      },
    });
  });
}

/**
 * Collect this machine's current Codex limits. A failed live read returns null,
 * so the sync loop leaves the last good database row intact.
 */
export async function collectCodexUsage(
  home = codexHome(),
  appServerOptions: CodexAppServerOptions = {},
): Promise<CodexUsageSample | null> {
  const limits = await readCodexLimits(appServerOptions);
  if (!limits) return null;

  const weekly = limits.weekly;
  return {
    usedPercent: weekly?.usedPercent ?? null,
    windowMinutes: weekly?.windowMinutes ?? null,
    resetsAt: weekly?.resetsAt ?? null,
    fiveHourPct: limits.fiveHour?.usedPercent ?? null,
    fiveHourResetsAt: limits.fiveHour?.resetsAt ?? null,
    fiveHourLimitId: limits.fiveHour?.limitId ?? null,
    fiveHourLimitName: limits.fiveHour?.limitName ?? null,
    weekPct: weekly?.usedPercent ?? null,
    weekResetsAt: weekly?.resetsAt ?? null,
    weekLimitId: weekly?.limitId ?? null,
    weekLimitName: weekly?.limitName ?? null,
    planType: limits.planType,
    daily: collectDaily(home),
    capturedAt: new Date().toISOString(),
  };
}
