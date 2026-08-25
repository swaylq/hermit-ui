// collect/kimi-usage.ts — how much of the Kimi Code subscription is left.
//
// Unlike Claude (scrape a TUI panel) and codex (read its rollout files), Kimi
// answers the question directly: `GET <baseUrl>/v1/usages`, authenticated with
// the same API key the sessions use, returns the account's quota. It is the
// endpoint the official Kimi CLI's own `/usage` command calls — found by
// reading @moonshot-ai/kimi-code rather than guessed, and verified against a
// live key before this shipped.
//
// It reports THREE different things, and conflating them would make the panel
// lie:
//
//   · `usage`   — the subscription quota. Refreshes every 7 days from the
//                 subscription date and does not roll over.
//   · `limits[]`— rolling RATE windows (300 minutes today). Having quota left
//                 does not stop a 429 here.
//   · `parallel`— concurrent requests allowed.
//
// `used` and `limit` are the vendor's own units and the docs never name them
// (the Kimi CLI renders used/limit as a percentage and so do we). Storing the
// raw pair rather than a computed percentage is deliberate: if the units ever
// change meaning, a stored ratio would be silently wrong forever while a stored
// pair can be re-read.
//
// Cost: one HTTP GET per Kimi credential, on the same 12-minute loop as the
// other two collectors. Nothing is scraped and no process is spawned.

import { getModelCredentials, type ModelCredential } from '../pi-config';
import { readSecret } from '../runtime/pi-credentials';

/** One rolling rate window as the dashboard stores it. */
export type KimiWindow = {
  /** Window length in minutes — 300 is the documented 5-hour one. */
  minutes: number | null;
  used: number | null;
  limit: number | null;
  resetsAt: string | null;
};

export type KimiUsageSample = {
  credentialId: string;
  planLevel: string | null;
  planName: string | null;
  periodUsed: number | null;
  periodLimit: number | null;
  periodResetsAt: string | null;
  windows: KimiWindow[];
  parallelLimit: number | null;
  extraBalanceCents: number | null;
  extraCurrency: string | null;
  capturedAt: string;
};

/**
 * Which credentials this endpoint exists for.
 *
 * Host-matched rather than provider-matched: `provider` is a free-text field on
 * the credential and a user may well type `kimi` or `moonshot`, while the host
 * is what actually decides whether `/v1/usages` is there. A self-hosted mirror
 * or a proxy in front of Kimi is deliberately NOT matched — its response shape
 * is nobody's promise, and a wrong quota reading is worse than none.
 */
export function isKimiCodeEndpoint(baseUrl: string | null | undefined): boolean {
  try {
    const host = new URL((baseUrl ?? '').trim()).host.toLowerCase();
    return host === 'api.kimi.com' || host === 'api.kimi.ai';
  } catch {
    return false;
  }
}

/** `https://api.kimi.com/coding` → `https://api.kimi.com/coding/v1`. */
export function apiRootFor(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  // The credential may name the endpoint with or without the version segment —
  // Claude Code wants it without, the Kimi CLI's own constant has it with.
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

/** `https://api.kimi.com/coding` → `https://api.kimi.com/coding/v1/usages`. */
export function usagesUrlFor(baseUrl: string): string {
  return `${apiRootFor(baseUrl)}/usages`;
}

function toInt(v: unknown): number | null {
  // The endpoint sends its integers as STRINGS ("100", "1"). Reading them with
  // `typeof v === 'number'` alone returns null for every field.
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Window length in minutes, from `{ duration, timeUnit }`. */
function windowMinutes(raw: unknown): number | null {
  const w = rec(raw);
  const duration = toInt(w?.duration);
  if (duration === null) return null;
  switch (w?.timeUnit) {
    case 'TIME_UNIT_MINUTE': return duration;
    case 'TIME_UNIT_HOUR': return duration * 60;
    case 'TIME_UNIT_DAY': return duration * 1440;
    case 'TIME_UNIT_WEEK': return duration * 10080;
    default: return null;
  }
}

/**
 * `used` is not always sent — the weekly row omits it and states `remaining`
 * instead. Deriving it keeps the panel from reading 0% used on an account that
 * has spent half its quota.
 */
function usedOf(detail: Record<string, unknown>): number | null {
  const direct = toInt(detail.used);
  if (direct !== null) return direct;
  const limit = toInt(detail.limit);
  const remaining = toInt(detail.remaining);
  return limit !== null && remaining !== null ? limit - remaining : null;
}

/** Wire fixed point (1e6 to the cent) → whole cents. */
function fixedPointToCents(v: unknown): number | null {
  const raw = toInt(v);
  if (raw === null || raw <= 0) return null;
  const cents = raw / 1e6;
  // A balance that rounds to zero is not an empty balance; the CLI floors it at
  // one cent for the same reason.
  return cents < 1 ? 1 : Math.round(cents);
}

function moneyCurrency(v: unknown): string | null {
  return str(rec(v)?.currency);
}

/** The `/v1/usages` body, normalised. Pure — the tests need no network. */
export function parseKimiUsage(body: unknown, credentialId: string, capturedAt: string): KimiUsageSample | null {
  const root = rec(body);
  if (!root) return null;

  const usage = rec(root.usage);
  const membership = rec(rec(root.user)?.membership);
  const wallet = rec(root.boosterWallet);
  const booster = rec(wallet?.balance);

  const windows: KimiWindow[] = [];
  for (const item of Array.isArray(root.limits) ? root.limits : []) {
    const entry = rec(item);
    const detail = rec(entry?.detail);
    if (!detail) continue;
    windows.push({
      minutes: windowMinutes(entry?.window),
      used: usedOf(detail),
      limit: toInt(detail.limit),
      resetsAt: str(detail.resetTime),
    });
  }

  // A body with no quota AND no window is not a usage reading — most likely an
  // error object that happened to parse. Returning null keeps the row absent
  // rather than writing an all-null one that renders as a real 0%.
  if (!usage && windows.length === 0) return null;

  return {
    credentialId,
    planLevel: str(membership?.level),
    planName: str(membership?.name) ?? str(rec(root.user)?.userLevelName),
    periodUsed: usage ? usedOf(usage) : null,
    periodLimit: usage ? toInt(usage.limit) : null,
    periodResetsAt: usage ? str(usage.resetTime) : null,
    windows,
    parallelLimit: toInt(rec(root.parallel)?.limit),
    // "Extra Usage": a wallet whose amounts arrive in fixed point, 1e6 units to
    // the cent — the same divisor the Kimi CLI applies. UNVERIFIED against a
    // live wallet: this fleet's account has none, and the shape is read off the
    // CLI's parser rather than a document. Guarded to a BOOSTER balance so an
    // unexpected wallet type reports nothing rather than a wrong number.
    extraBalanceCents: fixedPointToCents(booster?.type === 'BOOSTER' ? booster.amountLeft : null),
    extraCurrency: moneyCurrency(wallet?.monthlyChargeLimit) ?? moneyCurrency(wallet?.monthlyUsed),
    capturedAt,
  };
}

async function fetchJson(url: string, apiKey: string, timeoutMs = 15_000): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        // Ask for it UNCOMPRESSED, deliberately.
        //
        // api.kimi.com serves HTTP/2, and on undici's h2 path a gzipped
        // response comes back with the `content-encoding` header consumed but
        // the BODY still compressed — `res.json()` then throws on the gzip
        // magic bytes. Measured on Node 26.0.0, 2026-08-26: the same request
        // decodes correctly once the gateway's own dispatcher (allowH2: false)
        // is installed, and fails before it.
        //
        // So the working configuration depends on a dispatcher installed
        // elsewhere for an unrelated reason, which is not something a collector
        // should rest on. The body is ~500 bytes; compressing it saves nothing
        // worth that coupling.
        'accept-encoding': 'identity',
      },
      signal: ctl.signal,
    });
    if (!res.ok) {
      // The status, never the body: an auth failure here echoes back nothing
      // secret today, and "nothing secret today" is not a property to rely on.
      console.warn(`[kimi-usage] ${url} answered ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[kimi-usage] ${url} failed:`, (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The machine's Kimi quota, or null when it has no Kimi credential.
 *
 * Null rather than an empty sample, so the dashboard hides the panel instead of
 * rendering an empty one — same contract as collectCodexUsage.
 *
 * Only the FIRST Kimi credential is read. The row is keyed by machine, so a
 * second one would overwrite the first every 12 minutes and the panel would
 * flip between two accounts with nothing to say which was showing. A machine
 * that genuinely runs two Kimi keys needs a keyed table, not a louder guess.
 */
export async function collectKimiUsage(): Promise<KimiUsageSample | null> {
  const credentials = await getModelCredentials();
  const kimi = credentials.filter((c: ModelCredential) => isKimiCodeEndpoint(c.baseUrl));
  if (kimi.length === 0) return null;
  if (kimi.length > 1) {
    console.log(`[kimi-usage] ${kimi.length} Kimi credentials; reading ${kimi[0].id} only`);
  }

  const c = kimi[0];
  const secretName = c.secretKey?.trim();
  if (!secretName) return null;
  const key = await readSecret(secretName);
  if (!key) {
    console.warn(`[kimi-usage] credential ${c.id} names secret "${secretName}", which this machine's store does not hold`);
    return null;
  }

  const root = apiRootFor(c.baseUrl);
  const body = await fetchJson(`${root}/usages`, key);
  if (body === null) return null;
  const sample = parseKimiUsage(body, c.id, new Date().toISOString());
  if (!sample) return null;

  // The tier's HUMAN name is on a different endpoint. /usages knows the account
  // is LEVEL_ADVANCED; only /me knows Moonshot calls that "Allegro", which is
  // the word on the membership page the user is comparing this panel against.
  // Best-effort by design: a failure here leaves planName null and the panel
  // falls back to the level, rather than costing us the quota reading.
  if (!sample.planName) {
    const me = await fetchJson(`${root}/me`, key);
    const name = me && typeof me === 'object' ? (me as Record<string, unknown>).user_level_name : null;
    if (typeof name === 'string' && name.trim()) sample.planName = name.trim();
  }
  return sample;
}
