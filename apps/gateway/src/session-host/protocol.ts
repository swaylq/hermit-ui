// session-host/protocol.ts — the one line of JSON that opens a connection.
//
// Deliberately tiny, and deliberately the ONLY thing either side parses. After
// the opening exchange the socket carries raw stream-json bytes in both
// directions and the host does not look at them: it does not know what a turn
// is, what a tool call is, or that Claude Code is on the other end.
//
// That is the whole design, not an implementation detail. The gateway is 48k
// lines that change every day; the host holds the processes and must almost
// never restart. The only way to keep those two facts compatible is to make the
// surface between them so narrow that a gateway feature cannot need a host
// change. A byte stream plus one attach message is as narrow as it gets.
//
// Versioned because the day will come when it is not narrow enough: a host that
// does not recognise `v` says so and refuses, rather than misreading a newer
// gateway's message and holding a session it cannot serve.

export const HOST_PROTOCOL_VERSION = 1;

/** Attach to a session's child, spawning it if this host has none. */
export interface AttachRequest {
  v: number;
  op: 'attach';
  /** The hermit ChatSession id. One child per session, per host. */
  sessionId: string;
  /** The binary to run if a spawn is needed. */
  bin: string;
  /**
   * Exactly the argv the SDK meant to pass to claude. The shim forwards its own
   * argv rather than the gateway composing a second copy — the SDK owns that
   * list, it changes with the SDK, and a hand-written duplicate would drift.
   */
  argv: string[];
  cwd: string;
  /**
   * Environment for the spawn. NEVER LOGGED, by the host or anyone else: it
   * carries the child's credentials. It reaches the host over a 0600 unix
   * socket owned by the same user, which is the same trust boundary as handing
   * it to a child process directly.
   */
  env: Record<string, string>;
}

/** What the host is holding. For the gateway's own bookkeeping and for ops. */
export interface ListRequest {
  v: number;
  op: 'list';
}

/** End a session's child for good (hibernate, restart, delete). */
export interface KillRequest {
  v: number;
  op: 'kill';
  sessionId: string;
}

export type HostRequest = AttachRequest | ListRequest | KillRequest;

export interface AttachResponse {
  ok: true;
  /** True when this attach started the child, false when it adopted a live one. */
  spawned: boolean;
  pid: number;
  /** How long the child has been running, so the gateway can log a real number. */
  ageMs: number;
}

export interface ListResponse {
  ok: true;
  sessions: Array<{ sessionId: string; pid: number; ageMs: number; attached: boolean; idleMs: number }>;
}

export interface KillResponse {
  ok: true;
  killed: boolean;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type HostResponse = AttachResponse | ListResponse | KillResponse | ErrorResponse;

/**
 * Split at the first newline. On BYTES, deliberately.
 *
 * Both sides need this and both need it to be exact: whatever follows the
 * opening line is already protocol payload — the SDK writes its first control
 * request the moment it spawns, and it can land in the same TCP read as the
 * attach line. Dropping the remainder is a hang that reproduces once in fifty
 * starts.
 *
 * Doing it on a decoded string is worse than that, and was the first version of
 * this function. `chunk.toString('utf8')` on a read that ends mid-character
 * replaces the truncated bytes with U+FFFD; re-encoding the remainder then
 * hands the child different bytes than the SDK sent. Only the first chunk is
 * ever decoded that way, so the corruption is rare, silent, and lands in the
 * middle of a conversation in Chinese — which is most of them here.
 */
export function splitFirstLine(buf: Buffer): { line: string; rest: Buffer } | null {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return null;
  return { line: buf.subarray(0, nl).toString('utf8'), rest: buf.subarray(nl + 1) };
}

/** Parse an opening line, returning null rather than throwing on anything odd. */
export function parseRequest(line: string): HostRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const r = parsed as Partial<HostRequest> | null;
  if (!r || typeof r !== 'object') return null;
  if (r.op !== 'attach' && r.op !== 'list' && r.op !== 'kill') return null;
  if (r.v !== HOST_PROTOCOL_VERSION) return null;
  if (r.op === 'attach') {
    const a = r as Partial<AttachRequest>;
    if (!a.sessionId || !a.bin || !Array.isArray(a.argv) || !a.cwd) return null;
  }
  if (r.op === 'kill' && !(r as Partial<KillRequest>).sessionId) return null;
  return r as HostRequest;
}
