// A Node-side client for any pi-family CLI running `--mode rpc`.
//
// The wire is strict JSONL over stdio: one JSON object per line, LF only,
// requests correlated by `id`, everything else an event.
//
// **Split on `\n` and nothing else.** This used to use `readline`, and that is
// a protocol violation: readline also breaks on U+2028 and U+2029, which are
// perfectly legal inside a JSON string. One of those in any payload — scraped
// web text, a JS bundle echoed into a tool result — splits a record into two
// unparseable halves, and both get dropped silently. Both pi and prime document
// exactly this ("Do not use generic line readers that treat Unicode separators
// as newlines"); pi's own RpcClient is compliant, which is why the pi path never
// hit it and the hand-rolled omp path could.
//
// Used by the omp and prime backends. The pi backend drives pi's own typed
// RpcClient instead, which is compliant and gives us its API for free.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type RpcEvent = Record<string, unknown> & { type?: string };

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export type JsonlTransportOptions = {
  /** Argv[0]. Either a binary on PATH or an absolute path to a cli.js. */
  cliPath: string;
  /** Prefix argv — e.g. ['--mode', 'rpc'] — before the caller's own args. */
  baseArgs: string[];
  cwd: string;
  args: string[];
  env: Record<string, string>;
  /** Called for every non-response frame. */
  onEvent: (ev: RpcEvent) => void;
  /** Called once, when the child exits for any reason. */
  onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
  /** Frame that means "the child is up". Some CLIs announce, some do not. */
  readyType?: string;
  /** How long to wait for it. Ignored when readyType is unset. */
  readyTimeoutMs?: number;
  /** Prefix for log lines and error messages. */
  label: string;
};

/** Per-request ceiling. A model turn is NOT a request — `prompt` acks immediately. */
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
/** Kept only to explain a death; never parsed. */
const STDERR_TAIL_MAX = 4_000;
/** A single frame past this is a runaway, not a message. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export class JsonlTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderrTail = '';
  private exited = false;
  /** Set once the child announces itself; resolved by start(). */
  private ready: Record<string, unknown> | null = null;

  constructor(private opts: JsonlTransportOptions) {}

  get isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Spawn and, if this CLI announces one, wait for the ready frame. */
  async start(): Promise<Record<string, unknown>> {
    const child = spawn(this.opts.cliPath, [...this.opts.baseArgs, ...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stderr.on('data', (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString()).slice(-STDERR_TAIL_MAX);
    });

    this.attachReader(child);

    child.on('exit', (code, signal) => {
      this.exited = true;
      // Every in-flight request is now unanswerable. Rejecting them is what
      // lets the runtime notice death promptly instead of waiting out each
      // request timeout in turn.
      const err = new Error(
        `${this.opts.label} child exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
        + (this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-400)}` : ''),
      );
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
      this.opts.onExit({ code, signal, stderrTail: this.stderrTail });
    });

    if (!this.opts.readyType) return {};

    const timeout = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    while (!this.ready && !this.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (this.ready) return this.ready;
    if (this.exited) {
      throw new Error(
        `${this.opts.label} exited before announcing ready`
        + (this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-600)}` : ''),
      );
    }
    this.kill();
    throw new Error(`${this.opts.label} did not announce ready within ${timeout / 1000}s`);
  }

  /**
   * LF-only line assembly.
   *
   * Segments are kept in an array and joined exactly once, when the terminating
   * newline arrives. Appending to one growing accumulator and re-scanning it
   * with indexOf on every chunk is O(n^2) when a single record is split across
   * many reads, which is the normal case for a large tool result.
   */
  private attachReader(child: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder('utf8');
    let pendingParts: string[] = [];
    let pendingLength = 0;
    let discarding = false;

    child.stdout.on('data', (buf: Buffer) => {
      const chunk = decoder.write(buf);
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf('\n', from);
        if (nl === -1) break;
        if (discarding) {
          discarding = false;
        } else {
          pendingParts.push(chunk.slice(from, nl));
          this.onLine(pendingParts.join(''));
        }
        pendingParts = [];
        pendingLength = 0;
        from = nl + 1;
      }
      const rest = chunk.slice(from);
      if (rest) {
        pendingLength += rest.length;
        if (pendingLength > MAX_LINE_BYTES) {
          // Drop the runaway record rather than the session: a child that emits
          // one is broken about that message, not about the conversation.
          console.warn(`[${this.opts.label}] dropping an oversized frame (>${MAX_LINE_BYTES} bytes)`);
          pendingParts = [];
          pendingLength = 0;
          discarding = true;
        } else if (!discarding) {
          pendingParts.push(rest);
        }
      }
    });
  }

  private onLine(raw: string): void {
    // Tolerate CRLF input by stripping a trailing CR; the framing itself stays
    // LF-only, which is what the protocol specifies.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      // A malformed frame is the child's problem, not ours; dropping one is
      // strictly better than tearing down a live session over it.
      return;
    }

    if (this.opts.readyType && frame?.type === this.opts.readyType && !this.ready) {
      this.ready = frame;
      return;
    }

    if (frame?.type === 'response' && typeof frame.id === 'string') {
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.success === false) {
          p.reject(new Error(String(frame.error ?? `${this.opts.label} ${frame.command ?? 'command'} failed`)));
        } else {
          p.resolve(frame.data ?? {});
        }
        return;
      }
      // A response whose request already timed out. Nothing to do with it.
      return;
    }

    this.opts.onEvent(frame as RpcEvent);
  }

  /** Send a command and await its response. */
  send<T = any>(command: Record<string, unknown>): Promise<T> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error(`${this.opts.label} child is not running`));
    }
    const id = `hermit_${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${this.opts.label} response to "${String(command.type)}"`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Close stdin and let the child drain.
   *
   * The documented shutdown for both CLIs: on stdin close they reject pending
   * host requests, drain accepted commands, dispose the session and exit 0.
   * That ordering is why this is the hibernate path — it gives the session file
   * a chance to be written, which SIGKILL does not.
   */
  end(): void {
    try { this.child?.stdin.end(); } catch { /* already gone */ }
  }

  kill(): void {
    try { this.child?.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
