// runtime/session-host-client.ts — the gateway's side of the session host.
//
// Two things live here and nothing else: the options fragment that points the
// Agent SDK at the attach shim instead of at `claude`, and the two questions
// the gateway ever asks the host directly (what are you holding, and let this
// one go for good). Everything else between the two processes is the raw byte
// stream the shim carries; see session-host/protocol.ts for why that surface is
// kept this narrow.
//
// Off by default. `HERMIT_SESSION_HOST=1` turns it on for a machine, so the
// change can land, be reviewed and be run on one box before every session on
// the fleet depends on it.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBin } from '@hermit-ui/tmux-driver';
import { HOST_PROTOCOL_VERSION, type ListResponse, type KillResponse, type ErrorResponse } from '../session-host/protocol';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function sessionHostEnabled(): boolean {
  return process.env.HERMIT_SESSION_HOST === '1';
}

export function hostSocketPath(): string {
  return process.env.HERMIT_HOST_SOCK || path.join(os.homedir(), '.hermit', 'session-host', 'v1.sock');
}

/** The shim the SDK spawns believing it is `claude`. */
export function attachShimPath(): string {
  return path.join(HERE, '..', 'session-host', 'attach.mjs');
}

/**
 * The `query()` options that route a session through the host.
 *
 * `executable: 'node'` matters: the shim is plain .mjs so that no build step
 * sits in the path of a session spawn, and the SDK would otherwise try to guess
 * a runtime for a file it thinks is the Claude Code bundle.
 */
export function hostSpawnOptions(sessionId: string): {
  pathToClaudeCodeExecutable: string;
  executable: 'node';
  hostEnv: Record<string, string>;
} {
  return {
    pathToClaudeCodeExecutable: attachShimPath(),
    executable: 'node',
    hostEnv: {
      HERMIT_HOST_SOCK: hostSocketPath(),
      HERMIT_SESSION_ID: sessionId,
      // The shim never guesses where claude is; the gateway already resolved it
      // and the two must not be able to disagree.
      HERMIT_CLAUDE_BIN: resolveClaudeBin(),
    },
  };
}

/** One request, one JSON answer, connection closed. Never throws. */
async function ask<T>(body: unknown, timeoutMs = 3_000): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const conn = net.connect(hostSocketPath());
    let out = '';
    let settled = false;
    const done = (v: T | null) => {
      if (settled) return;
      settled = true;
      try { conn.destroy(); } catch { /* already gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    conn.on('connect', () => conn.write(`${JSON.stringify(body)}\n`));
    conn.on('data', (d) => {
      out += d.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try { done(JSON.parse(out.slice(0, nl)) as T); } catch { done(null); }
    });
    // A host that is not running is the ordinary case on a machine that has not
    // opted in, and on every machine for the first second after a reboot.
    conn.on('error', () => { clearTimeout(timer); done(null); });
    conn.on('close', () => { clearTimeout(timer); done(null); });
  });
}

/** What the host is holding, or null when there is no host to ask. */
export async function hostSessions(): Promise<ListResponse['sessions'] | null> {
  const res = await ask<ListResponse | ErrorResponse>({ v: HOST_PROTOCOL_VERSION, op: 'list' });
  return res && res.ok ? res.sessions : null;
}

/**
 * End a session's child for good.
 *
 * Needed because tearing down the SDK handle only kills the SHIM — which is the
 * entire point of the shim, and exactly wrong when the caller means "this
 * session is over". Hibernate, restart and delete all mean that; a gateway
 * shutdown does not, and uses `detach` instead.
 */
export async function hostKill(sessionId: string): Promise<boolean> {
  const res = await ask<KillResponse | ErrorResponse>({ v: HOST_PROTOCOL_VERSION, op: 'kill', sessionId });
  return !!(res && res.ok && (res as KillResponse).killed);
}
