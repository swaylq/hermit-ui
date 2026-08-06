// A Node-side client for `omp --mode rpc`.
//
// omp ships its own RpcClient, and its option and method surface match the one
// pi-rpc.ts uses almost exactly — but it cannot be imported here: omp's library
// code does `import ... from "bun"` (via @oh-my-pi/pi-utils), and Node cannot
// resolve that. Running the gateway on Bun to get one library is not a trade
// worth making for ~24 live claude sessions, so this speaks the wire protocol
// instead. It is NDJSON over stdio and fully documented, and we only need eight
// of its commands.
//
// One thing this gets to do better than the pi path: process death is observed
// directly off the child's 'exit' event, rather than sniffed out of an error
// message (see isDeadClientError in pi-rpc.ts).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export type OmpEvent = Record<string, unknown> & { type?: string };

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export type OmpTransportOptions = {
  cliPath: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  /** Called for every non-response frame. */
  onEvent: (ev: OmpEvent) => void;
  /** Called once, when the child exits for any reason. */
  onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
};

/** Per-request ceiling. A model turn is NOT a request — `prompt` acks immediately. */
const REQUEST_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;
/** Kept only to explain a death; never parsed. */
const STDERR_TAIL_MAX = 4_000;

export class OmpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderrTail = '';
  private exited = false;
  /** Set once the child announces itself; resolved by start(). */
  private ready: Record<string, unknown> | null = null;

  constructor(private opts: OmpTransportOptions) {}

  get isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Spawn and wait for the `ready` frame. Throws if the child dies first. */
  async start(): Promise<Record<string, unknown>> {
    const child = spawn(this.opts.cliPath, ['--mode', 'rpc', ...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stderr.on('data', (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString()).slice(-STDERR_TAIL_MAX);
    });

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));

    child.on('exit', (code, signal) => {
      this.exited = true;
      // Every in-flight request is now unanswerable. Rejecting them is what
      // lets the runtime notice death promptly instead of waiting out each
      // request timeout in turn.
      const err = new Error(
        `omp child exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
        + (this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-400)}` : ''),
      );
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
      this.opts.onExit({ code, signal, stderrTail: this.stderrTail });
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!this.ready && !this.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (this.ready) return this.ready;
    if (this.exited) {
      throw new Error(
        `omp exited before announcing ready${this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-600)}` : ''}`,
      );
    }
    this.kill();
    throw new Error(`omp did not announce ready within ${READY_TIMEOUT_MS / 1000}s`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      // A malformed frame is the child's problem, not ours; dropping one is
      // strictly better than tearing down a live session over it.
      return;
    }

    if (frame?.type === 'ready') { this.ready = frame; return; }

    if (frame?.type === 'response' && typeof frame.id === 'string') {
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.success === false) {
          p.reject(new Error(String(frame.error ?? `omp ${frame.command ?? 'command'} failed`)));
        } else {
          p.resolve(frame.data ?? {});
        }
        return;
      }
      // A response whose request already timed out. Nothing to do with it.
      return;
    }

    this.opts.onEvent(frame as OmpEvent);
  }

  /** Send a command and await its response. */
  send<T = any>(command: Record<string, unknown>): Promise<T> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error('omp child is not running'));
    }
    const id = `hermit_${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for omp response to "${String(command.type)}"`));
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
   * omp's documented shutdown: on stdin close it rejects pending host requests,
   * drains accepted commands, disposes the session and exits 0. That ordering
   * is why this is the hibernate path — it gives the session file a chance to
   * be written, which SIGKILL does not.
   */
  end(): void {
    try { this.child?.stdin.end(); } catch { /* already gone */ }
  }

  kill(): void {
    try { this.child?.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
