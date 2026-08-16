// Live-preview registry — the Mac-side truth for "which unguessable preview id
// maps to which local target". Serving (serve.ts) and administration (admin.ts)
// both read it; state survives a gateway restart via a JSON file so an open
// dashboard panel self-heals after `pm2 restart hermit-ui-gateway`.
//
// Security model (docs/live-preview-design in the artifact; §7):
//   · previewId is a capability: 16 random bytes, base64url — not enumerable.
//     Same posture as /uploads' "uuid-as-secret" on the dashboard.
//   · a static root must live under an allowed root (AGENTS_ROOT, the worktree
//     home, or PREVIEW_ALLOW_ROOTS) — registering ~/.ssh is refused outright.
//   · a proxy target is pinned at registration time and must be loopback; the
//     serve port never becomes a general-purpose forwarder.
//   · entries expire 24h after their last hit; `hermit-preview off`, session
//     close and the hourly sweep all end in the same removeBySession().

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AGENTS_ROOT, PREVIEW_ALLOW_ROOTS } from '../config';

export type PreviewMode = 'static' | 'proxy';

export interface PreviewEntry {
  previewId: string;
  sessionId: string;
  mode: PreviewMode;
  /** static: realpath of the served directory. proxy: normalized http://127.0.0.1:PORT[/base] URL. */
  target: string;
  /** Directory whose mtime changes trigger a full-page reload (static: the root; proxy: --watch dir or null). */
  watchDir: string | null;
  /** static only: unknown paths fall back to index.html (front-end routers). */
  spa: boolean;
  /** Inject the SSE auto-reload client into served HTML. */
  reload: boolean;
  createdAt: number;
  lastHitAt: number;
}

const STATE_FILE = path.join(os.homedir(), '.hermit', 'preview-state.json');
export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20;

const byId = new Map<string, PreviewEntry>();

// ── persistence ──────────────────────────────────────────────────────────────

let persistTimer: NodeJS.Timeout | null = null;

function persistSoon() {
  // Coalesce: lastHitAt advances on every asset request; writing the file per
  // hit would be pure churn. One write per 5s window is plenty for a value
  // whose only job is surviving a restart within a 24h TTL.
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: [...byId.values()] }, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.error('[preview] persist failed:', e instanceof Error ? e.message : e);
    }
  }, 5_000);
}

export function loadRegistry(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { entries?: PreviewEntry[] };
    const now = Date.now();
    for (const e of raw.entries ?? []) {
      if (!e?.previewId || !e.sessionId || !e.target) continue;
      if (now - (e.lastHitAt ?? 0) > PREVIEW_TTL_MS) continue; // expired while we were down
      byId.set(e.previewId, e);
    }
    if (byId.size) console.log(`[preview] restored ${byId.size} registration(s)`);
  } catch {
    /* first boot / no file — fine */
  }
}

// ── lookups ──────────────────────────────────────────────────────────────────

export function getById(previewId: string): PreviewEntry | null {
  return byId.get(previewId) ?? null;
}

export function getBySession(sessionId: string): PreviewEntry | null {
  for (const e of byId.values()) if (e.sessionId === sessionId) return e;
  return null;
}

/** The unprefixed-request fallback of last resort: only safe when unambiguous. */
export function soleEntry(): PreviewEntry | null {
  return byId.size === 1 ? byId.values().next().value ?? null : null;
}

export function touch(e: PreviewEntry): void {
  e.lastHitAt = Date.now();
  persistSoon();
}

// ── mutation ─────────────────────────────────────────────────────────────────

export function register(input: {
  sessionId: string;
  mode: PreviewMode;
  target: string;
  watchDir: string | null;
  spa: boolean;
  reload: boolean;
}): PreviewEntry {
  // One preview per session: re-registering rotates the id (old capability URL
  // dies immediately — that's a feature, not an accident).
  removeBySession(input.sessionId);
  if (byId.size >= MAX_ENTRIES) {
    throw new Error(`preview limit reached (${MAX_ENTRIES}) — run \`hermit-preview off\` in an unused session first`);
  }
  const entry: PreviewEntry = {
    previewId: `pv_${crypto.randomBytes(16).toString('base64url')}`,
    createdAt: Date.now(),
    lastHitAt: Date.now(),
    ...input,
  };
  byId.set(entry.previewId, entry);
  persistSoon();
  return entry;
}

export function removeBySession(sessionId: string): PreviewEntry | null {
  const e = getBySession(sessionId);
  if (!e) return null;
  byId.delete(e.previewId);
  persistSoon();
  return e;
}

/** Drop entries idle past the TTL; returns what was removed so the caller can clear the dashboard column. */
export function sweepExpired(): PreviewEntry[] {
  const now = Date.now();
  const dead: PreviewEntry[] = [];
  for (const e of byId.values()) {
    if (now - e.lastHitAt > PREVIEW_TTL_MS) dead.push(e);
  }
  for (const e of dead) byId.delete(e.previewId);
  if (dead.length) persistSoon();
  return dead;
}

// ── validation ───────────────────────────────────────────────────────────────

function allowedRoots(): string[] {
  const roots = [AGENTS_ROOT, path.join(os.homedir(), '.hermit', 'worktrees'), ...PREVIEW_ALLOW_ROOTS];
  const out: string[] = [];
  for (const r of roots) {
    if (!r) continue;
    try {
      out.push(fs.realpathSync(r));
    } catch {
      /* nonexistent root — skip */
    }
  }
  return out;
}

/** Throws a human-readable error unless dir is a directory under an allowed root. Returns its realpath. */
export function validateStaticRoot(dir: string): string {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    throw new Error(`directory not found: ${dir}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const ok = allowedRoots().some((r) => real === r || real.startsWith(r + path.sep));
  if (!ok) {
    throw new Error(
      `refusing to serve ${real} — static roots must live under AGENTS_ROOT or ~/.hermit/worktrees ` +
        `(extend with PREVIEW_ALLOW_ROOTS=/a:/b in apps/gateway/.env)`,
    );
  }
  return real;
}

/** Accepts '5173', '127.0.0.1:5173' or 'http://127.0.0.1:5173[/base]'; returns a normalized URL string. Loopback only. */
export function validateProxyTarget(raw: string): string {
  let s = raw.trim();
  if (/^\d{2,5}$/.test(s)) s = `http://127.0.0.1:${s}`;
  else if (/^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`not a valid target: ${raw} — use a port number ('5173') or an http://127.0.0.1:PORT URL`);
  }
  if (u.protocol !== 'http:') throw new Error(`only http:// targets are supported (got ${u.protocol}//) — TLS terminates at the edge`);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) {
    throw new Error(`proxy target must be loopback (127.0.0.1 / localhost), got ${u.hostname}`);
  }
  if (!u.port) throw new Error('proxy target needs an explicit port');
  u.hash = '';
  u.search = '';
  return u.toString().replace(/\/$/, '');
}
