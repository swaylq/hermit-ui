import type { IncomingHttpHeaders } from 'node:http';

/** Header-first during the rolling upgrade; query remains a legacy fallback. */
export function gatewayUpgradeKey(headers: IncomingHttpHeaders, legacyQuery: unknown): string {
  const raw = headers['x-asst-key'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return typeof header === 'string' && header ? header : String(legacyQuery ?? '');
}
