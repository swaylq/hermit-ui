// Watching for the one policy change that would invalidate the claude-sdk backend.
//
// The whole reason this fleet can run Claude Code through the Agent SDK is that
// SDK traffic draws on the ordinary subscription windows. That was not always
// true, and it was not always going to stay true: Anthropic announced on
// 2026-05-13 that from 2026-06-15 the SDK, `claude -p`, GitHub Actions and
// third-party apps would move onto a separate monthly credit at API rates, then
// PAUSED the change on the day it was due to take effect. Paused is not
// cancelled. `evolution/lessons.md` → L1 records both halves.
//
// If it returns, the failure mode is quiet and expensive: nothing breaks, the
// fleet just starts spending a metered credit instead of the subscription, and
// the first symptom is a bill. So watch for it directly.
//
// The signal is in the plan's own rate-limit payload. On this account today:
//
//     five_hour            : { utilization: 4, ... }     ← shared with interactive
//     seven_day            : { utilization: 6, ... }     ← shared with interactive
//     seven_day_oauth_apps : null                        ← the SDK/third-party bucket
//
// A non-null `*_oauth_apps` window means the split is live and this backend is
// no longer free. Reading it costs nothing — it is a control request to a CLI
// that is already running, not a model call.
//
// ── The precondition, and what happens when it stops holding ────────────────
//
// "A CLI that is already running" is the catch. The probe asks the LIVE sessions
// and returns null when there are none, and this tick used to answer that with a
// bare `return`. On a machine with nothing open — a laptop overnight, a fleet
// member nobody has messaged in a week — the sentinel was therefore permanently
// and invisibly off: "no alert" and "never checked" produced identical output,
// which is exactly the shape of a guard that is not there.
//
// It cannot force a reading without spawning a CLI, and spawning one hourly to
// ask a billing question is not a trade this should make on its own. What it can
// do is refuse to be silent about it: the last successful reading is stamped, and
// a gap wide enough to matter says so. A stale sentinel is a finding.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeSdkRuntime } from '../runtime/claude-sdk';
import { api } from '../api';

/** Windows that would only ever be populated by a separate programmatic bucket. */
const SPLIT_KEYS = ['seven_day_oauth_apps', 'five_hour_oauth_apps', 'oauth_apps'];

/** Survives a gateway restart, so the alert fires once per episode, not per boot. */
const MARKER = path.join(os.homedir(), '.hermit', 'sdk-bucket-split.json');

/**
 * When the windows were last actually READ, and when we last said they were not.
 *
 * Deliberately a second file rather than a field on MARKER: MARKER means "the
 * split was reported", is read on the hot path by `alreadyReported`, and should
 * not start changing shape for a different concern.
 */
const STATE = path.join(os.homedir(), '.hermit', 'sdk-bucket-state.json');

/** No reading for this long means the check is not running. */
export const STALE_AFTER_MS = 6 * 60 * 60_000;

/** ...and keep saying so, at this interval, for as long as it stays true. */
export const STALE_REPEAT_MS = 24 * 60 * 60_000;

export type SentinelState = { lastOkAt?: number; lastStaleWarnAt?: number };

function readState(): SentinelState {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return {
      lastOkAt: typeof j?.lastOkAt === 'number' ? j.lastOkAt : undefined,
      lastStaleWarnAt: typeof j?.lastStaleWarnAt === 'number' ? j.lastStaleWarnAt : undefined,
    };
  } catch {
    return {};
  }
}

function writeState(st: SentinelState) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  } catch { /* best effort — a lost stamp costs one extra warning, not a wrong one */ }
}

/**
 * Has the sentinel gone quiet long enough to be worth saying so?
 *
 * Returns the state to persist and the line to log, if any. Pure, with the clock
 * passed in, because the whole point is behaviour that only manifests after
 * hours of a particular kind of nothing happening — which is not observable by
 * running the gateway and looking at it.
 *
 * A first-ever run has no stamp. That is not a six-hour gap, it is a machine
 * that has never checked, so the clock STARTS rather than the warning firing.
 */
export function noteProbeGap(
  st: SentinelState,
  probedOk: boolean,
  now: number,
): { next: SentinelState; warning: string | null } {
  if (probedOk) return { next: { lastOkAt: now }, warning: null };
  if (st.lastOkAt == null) return { next: { ...st, lastOkAt: now }, warning: null };
  const gap = now - st.lastOkAt;
  if (gap < STALE_AFTER_MS) return { next: st, warning: null };
  const saidRecently = st.lastStaleWarnAt != null && now - st.lastStaleWarnAt < STALE_REPEAT_MS;
  if (saidRecently) return { next: st, warning: null };
  const hours = Math.floor(gap / 3_600_000);
  return {
    next: { ...st, lastStaleWarnAt: now },
    warning:
      '[sdk-bucket] the Agent SDK billing sentinel has not been able to read the plan ' +
      `windows for ${hours}h — no live claude-sdk session to ask. The split check is NOT ` +
      'running on this machine. Open or message any claude-sdk session to restore it.',
  };
}

function alreadyReported(): boolean {
  try {
    return JSON.parse(fs.readFileSync(MARKER, 'utf8'))?.reported === true;
  } catch {
    return false;
  }
}

function markReported(detail: unknown) {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify({ reported: true, at: new Date().toISOString(), detail }, null, 2));
  } catch { /* the log line below is the real alert; the marker is only dedup */ }
}

/**
 * Which split windows are populated, if any.
 *
 * Exported for the unit test — this predicate is the whole check, and it has to
 * be exercised against a payload we cannot produce on demand.
 */
export function splitBucketsIn(rateLimits: Record<string, any> | null): string[] {
  if (!rateLimits) return [];
  return SPLIT_KEYS.filter((k) => {
    const w = rateLimits[k];
    if (w == null) return false;
    // A window that exists but reports nothing is not evidence of a live split.
    return typeof w === 'object'
      && (typeof w.utilization === 'number' || w.limit_dollars != null || w.resets_at != null);
  });
}

const runtime = new ClaudeSdkRuntime();

/**
 * One check. Cheap enough to run hourly and silent unless something changed.
 *
 * The notice lands in the session the reading came from: the alert belongs where
 * the spend is happening, and a gateway log line on its own has a poor record of
 * reaching anybody on this fleet.
 */
export async function sdkBucketTick(): Promise<void> {
  if (alreadyReported()) return;
  let probe: { sessionId: string; rateLimits: Record<string, any> } | null = null;
  try {
    probe = await runtime.probeRateLimits();
  } catch {
    probe = null; // old CLI, transport blip — indistinguishable from nothing to ask
  }
  // Whether there was anything to read is itself worth recording: a sentinel
  // that cannot run is a finding, not a no-op.
  const { next, warning } = noteProbeGap(readState(), probe != null, Date.now());
  writeState(next);
  if (warning) console.error(warning);
  if (!probe) return;
  const limits = probe.rateLimits ?? null;
  const split = splitBucketsIn(limits);
  if (split.length === 0) return;

  const detail = Object.fromEntries(split.map((k) => [k, limits![k]]));
  console.error(
    '[sdk-bucket] ⚠️  THE AGENT SDK BILLING SPLIT IS LIVE. ' +
    `Populated windows: ${split.join(', ')}. ` +
    'claude-sdk sessions are now drawing on a metered credit at API rates, not the subscription. ' +
    'Switch affected agents back to claude-tmux (Settings → Backends, or per session) and ' +
    'update evolution/lessons.md → L1. Detail: ' + JSON.stringify(detail),
  );
  markReported(detail);

  // …and say it somewhere a human actually looks.
  try {
    await api.syncChatMessages([{
      sessionId: probe.sessionId,
      role: 'system',
      content: [{
        type: 'text',
        text:
          '[gateway] ⚠️ Anthropic 的 Agent SDK 独立计费额度已经生效（检测到 ' +
          `${split.join(', ')}）。claude-sdk 后端现在按 API 计价走单独额度，不再走订阅。` +
          '建议把相关 agent 切回 claude-tmux，并更新 evolution/lessons.md → L1。',
      }],
      externalId: 'sdk-bucket-split',
    }]);
  } catch { /* the console line and the marker already carry it */ }
}
