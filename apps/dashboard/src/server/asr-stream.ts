// Realtime voice input, server half: one browser dictation session ⇄ one DashScope
// streaming-ASR task, plus the per-sentence polish that runs beside it.
//
// WHY A PROXY AT ALL. DASHSCOPE_API_KEY cannot go to the browser and DashScope
// issues no ephemeral token for this API, so the audio has to pass through us.
// The socket that carries it is wired up in ../server.ts (a third `upgrade`
// branch next to /api/gateway/ws and /api/term/<id>); this file is only the
// DashScope side of that bridge and knows nothing about HTTP or auth.
//
// THE PROTOCOL (measured against the live endpoint, 2026-08-20 — see
// docs/realtime-voice-input-design.md for the raw traces):
//   run-task ─→ task-started ─→ [binary PCM]* ─→ result-generated* ─→ finish-task
//   result-generated carries payload.output.sentence:
//     { text, begin_time, end_time, sentence_end }
//   sentence_end:false = a partial that REWRITES ITSELF as more audio lands
//     ("发" → "发 red hot" → "把Red Hole的隧道重启") — first one ~250 ms after
//     task-started. That self-correction is the effect worth keeping; we pass
//     partials through untouched rather than debouncing them smooth.
//   sentence_end:true = that sentence is closed. It fires MID-STREAM, ~2 s after
//     the speaker paused, while the audio keeps flowing — which is the whole
//     trick: sentence N goes off to be polished during sentence N+1, so the
//     ~0.5 s polish never becomes a wait.
//
// WHY POLISH IS NOT OPTIONAL. Streaming ASR returns a DRAFT. On the probe clips
// every technical term was wrong — rathole→"Red Hole", caddy→"pady",
// japan-dev→"japan dev" — and all three were sitting in the agent's previous
// reply. So each closed sentence goes to a small chat model with the recent
// conversation (transcribe-context) as reference. Style is the user's own
// setting; realtime defaults to `minimal` (correct, don't rewrite) because what
// was asked for is the user's ORIGINAL sentence, recognized accurately.
//
// TASK LIFECYCLE. The DashScope task is opened lazily on the first audio frame
// and closed again after IDLE_MS of silence — DashScope bills by audio second, so
// a dictation bar left open while nobody speaks must not be streaming anything.
// Reopening costs ~350 ms, which lands inside the first syllable because push()
// buffers whatever arrives while the task is opening and flushes it on
// task-started. A task is also recycled after TASK_MAX_MS so a long dictation
// never runs into whatever the server-side ceiling turns out to be; the recycle
// waits for a sentence boundary so no words straddle it.
//
// Nothing here throws at the caller. A dead ASR task is reported through
// onError(fatal) and the browser falls back to the batch /api/transcribe path
// with the audio it has been keeping since the last closed sentence.

import { WebSocket as WSClient, type RawData } from 'ws';
import { dashscopeChat } from './dashscope';
import type { ORMessage } from './openrouter';
import {
  POLISH_SYSTEM,
  MINIMAL_POLISH_SYSTEM,
  SENTENCE_SYSTEM_SUFFIX,
  polishPrompt,
  acceptPolish,
  inventedTerm,
  type PolishStyle,
} from './transcribe-polish';

const WS_URL = process.env.DASHSCOPE_REALTIME_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const ASR_MODEL = process.env.DASHSCOPE_REALTIME_ASR_MODEL || 'fun-asr-realtime';
const POLISH_MODEL = process.env.DASHSCOPE_POLISH_MODEL || 'qwen-flash';
// Optional hotword list (see the design doc's P4). Created out-of-band via
// /api/v1/services/audio/asr/customization; unset means plain decoding.
const VOCABULARY_ID = process.env.DASHSCOPE_ASR_VOCABULARY_ID || '';

/** Silence after which the DashScope task is closed (it bills per audio second). */
const IDLE_MS = 20_000;
/** Recycle a task at least this often, at the next sentence boundary. */
const TASK_MAX_MS = 4 * 60_000;
/** …and unconditionally this long after that, boundary or not. */
const TASK_HARD_MS = TASK_MAX_MS + 30_000;
/** How long finish() waits for the tail of the transcript before giving up on it. */
const FLUSH_MS = 6_000;
/** …and then for the polish jobs still in flight. */
const POLISH_DRAIN_MS = 8_000;
/** Sentences of this run handed to polish as `<preceding>` reference. */
const PRECEDING_SENTENCES = 2;
/** Consecutive dead opens before we stop retrying and tell the browser to fall back. */
const MAX_OPEN_FAILURES = 3;

export interface AsrStreamEvents {
  /** The ASR task is live and audio is flowing (fires again after each recycle). */
  onReady: () => void;
  /** Current unstable sentence-so-far. Rewrites itself; render as-is. */
  onPartial: (text: string) => void;
  /** A sentence closed. Raw ASR — good enough to show, not good enough to keep. */
  onFinal: (segId: number, text: string) => void;
  /** …and here is that same sentence, corrected. */
  onPolished: (segId: number, text: string) => void;
  onError: (message: string, fatal: boolean) => void;
}

export interface AsrStreamOpts {
  apiKey: string;
  /** Recent conversation, from transcribe-context. Reference for the polish step. */
  context: string;
  style: PolishStyle;
  /** false = pass raw ASR straight through (the P1 behaviour / a debug switch). */
  polish: boolean;
}

export interface AsrStream {
  /** Feed 16 kHz mono PCM16. Opens the ASR task on the first call. */
  push: (pcm: Buffer) => void;
  /** Close the ASR task, wait for the tail + outstanding polish, then resolve. */
  finish: () => Promise<void>;
  /** Drop everything now (browser vanished). */
  close: () => void;
}

type TaskState = 'idle' | 'opening' | 'running' | 'finishing';

function randomTaskId(): string {
  let s = '';
  while (s.length < 32) s += Math.random().toString(36).slice(2);
  return s.slice(0, 32);
}

export function createAsrStream(opts: AsrStreamOpts, events: AsrStreamEvents): AsrStream {
  let state: TaskState = 'idle';
  let ws: WSClient | null = null;
  let taskId = '';
  let taskOpenedAt = 0;
  let pending: Buffer[] = [];      // audio that arrived while the task was opening
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let recycleWanted = false;       // past TASK_MAX_MS — close at the next sentence end
  let ending = false;              // finish()/close() called — a recycle must NOT reopen
  let failedOpens = 0;             // consecutive opens that died before task-started
  let closed = false;              // the whole stream is done; ignore everything

  let nextSegId = 1;
  const finals: string[] = [];     // raw sentences of this run, for <preceding>
  const polishJobs = new Set<Promise<void>>();

  // A finish() in progress — resolved when task-finished lands (or FLUSH_MS).
  let flushResolve: (() => void) | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function log(...a: unknown[]) {
    console.log('[asr-stream]', ...a);
  }

  // Audio waiting for a task to come up. Bounded: if the task never opens, this
  // must not grow into a memory leak — ~10 s of 16 kHz PCM16 is plenty of runway
  // for a ~350 ms reconnect, and beyond that the oldest frames are worthless.
  const PENDING_MAX_BYTES = 10 * 16_000 * 2;
  function queue(pcm: Buffer) {
    pending.push(pcm);
    let total = pending.reduce((n, b) => n + b.length, 0);
    while (total > PENDING_MAX_BYTES && pending.length > 1) {
      total -= pending.shift()!.length;
    }
  }

  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function armIdle() {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (state === 'running') {
        log('idle → closing the ASR task (reopens on the next frame)');
        endTask();
      }
    }, IDLE_MS);
  }

  // ── polish ────────────────────────────────────────────────────────────────

  function polishMessages(raw: string, preceding: string): ORMessage[] {
    const base = opts.style === 'minimal' ? MINIMAL_POLISH_SYSTEM : POLISH_SYSTEM;
    return [
      { role: 'system', content: base + SENTENCE_SYSTEM_SUFFIX },
      { role: 'user', content: polishPrompt(raw, opts.context, preceding) },
    ];
  }

  function schedulePolish(segId: number, raw: string) {
    if (!opts.polish || !raw) return;
    const preceding = finals.slice(-1 - PRECEDING_SENTENCES, -1).join('');
    const job = (async () => {
      try {
        const out = await dashscopeChat(opts.apiKey, POLISH_MODEL, polishMessages(raw, preceding), {
          // 0, not the batch route's 0.2. This is a correction, not a
          // composition — there is one right answer and it is written in the
          // context. Measured on the same clip at 0.2: "Red Hole" was restored
          // to "rathole" in two runs out of three, and left wrong in the third.
          temperature: 0,
          timeoutMs: 15_000,
        });
        if (closed) return;
        // Two backstops, both meaning "keep the user's own words": acceptPolish
        // catches the model ANSWERING instead of cleaning, inventedTerm catches
        // it guessing a term out of thin air (see transcribe-polish.ts).
        if (!acceptPolish(raw, out)) return;
        const invented = inventedTerm(raw, out, opts.context);
        if (invented) {
          log(`polish invented "${invented}" — keeping the raw sentence`);
          return;
        }
        events.onPolished(segId, out);
      } catch (e) {
        log('polish failed, keeping raw —', String(e));
      }
    })();
    polishJobs.add(job);
    void job.finally(() => polishJobs.delete(job));
  }

  // ── DashScope task ────────────────────────────────────────────────────────

  function openTask() {
    if (closed || state === 'opening' || state === 'running') return;
    state = 'opening';
    taskId = randomTaskId();
    recycleWanted = false;
    const sock = new WSClient(WS_URL, {
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'user-agent': 'hermit-ui/asr' },
    });
    ws = sock;

    sock.on('open', () => {
      if (sock !== ws) return;
      sock.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: ASR_MODEL,
          parameters: {
            format: 'pcm',
            sample_rate: 16_000,
            // Mixed zh/en is the normal case here (repo names, CLI flags).
            language_hints: ['zh', 'en'],
            punctuation_prediction_enabled: true,
            // Silence that closes a sentence. 800 ms is DashScope's default and
            // measured right: a comma-length breath keeps the sentence open, a
            // real pause closes it ~2 s later.
            max_sentence_silence: 800,
            ...(VOCABULARY_ID ? { vocabulary_id: VOCABULARY_ID } : {}),
          },
          input: {},
        },
      }));
    });

    sock.on('message', (raw: RawData, isBinary: boolean) => {
      if (sock !== ws || isBinary) return;
      let msg: {
        header?: { event?: string; error_message?: string; error_code?: string };
        payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } };
      };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const ev = msg.header?.event;

      if (ev === 'task-started') {
        state = 'running';
        failedOpens = 0;
        taskOpenedAt = Date.now();
        for (const buf of pending) { try { sock.send(buf); } catch { /* closing */ } }
        pending = [];
        armIdle();
        events.onReady();
        return;
      }

      if (ev === 'result-generated') {
        const s = msg.payload?.output?.sentence;
        const text = (s?.text ?? '').trim();
        if (s?.sentence_end) {
          if (text) {
            const segId = nextSegId++;
            finals.push(text);
            events.onFinal(segId, text);
            schedulePolish(segId, text);
          }
          // A recycle waits for exactly this moment so no sentence straddles it.
          if (recycleWanted && state === 'running') endTask();
          return;
        }
        // Partial. Empty ones happen at the very start; don't wipe the bar.
        if (text) events.onPartial(text);
        return;
      }

      if (ev === 'task-finished') {
        settleFinish();
        teardownSocket();
        return;
      }

      if (ev === 'task-failed') {
        const detail = `${msg.header?.error_code ?? ''} ${msg.header?.error_message ?? ''}`.trim();
        log('task-failed', detail);
        events.onError(detail || 'ASR task failed', true);
        settleFinish();
        teardownSocket();
        return;
      }
    });

    sock.on('error', (e: Error) => {
      if (sock !== ws) return;
      log('socket error', e.message);
      events.onError(e.message, true);
      settleFinish();
      teardownSocket();
    });

    sock.on('close', () => {
      if (sock !== ws) return;
      // Never reached 'running' → this open failed. Counted so a permanently
      // broken upstream (bad key, DNS, region block) can't hot-loop reconnects
      // off the back of the pending buffer.
      if (state === 'opening') failedOpens += 1;
      // A close we didn't ask for while audio is still coming: report it, let the
      // browser decide (it falls back to the batch route with its local buffer).
      if (state === 'running' || state === 'opening') {
        events.onError('ASR connection closed', true);
      }
      settleFinish();
      teardownSocket();
    });
  }

  // Drop the DashScope socket but NOT the buffered audio: a recycle (idle close,
  // TASK_MAX_MS) is invisible to the user, and the frames that arrived while the
  // old task was winding down belong to the next one.
  function teardownSocket() {
    clearIdle();
    const sock = ws;
    ws = null;
    state = 'idle';
    if (sock) { try { sock.close(); } catch { /* already gone */ } }
    if (closed || ending) { pending = []; return; }
    if (failedOpens >= MAX_OPEN_FAILURES) {
      pending = [];
      events.onError('ASR upstream unreachable', true);
      return;
    }
    if (pending.length) openTask();
  }

  /** Politely end the current task (keeps the stream usable — a push reopens one). */
  function endTask() {
    if (state !== 'running' || !ws) { teardownSocket(); return; }
    state = 'finishing';
    clearIdle();
    try {
      ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      }));
    } catch {
      teardownSocket();
    }
  }

  function settleFinish() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const r = flushResolve;
    flushResolve = null;
    r?.();
  }

  // ── public surface ────────────────────────────────────────────────────────

  return {
    push(pcm: Buffer) {
      if (closed || !pcm.length) return;
      if (state === 'idle') { queue(pcm); openTask(); return; }
      if (state === 'opening' || state === 'finishing') {
        // Mid-recycle audio is not dropped — it belongs to the next task, which
        // teardownSocket opens as soon as this one is done winding down.
        queue(pcm);
        return;
      }
      // running
      const age = Date.now() - taskOpenedAt;
      if (age > TASK_HARD_MS) { queue(pcm); endTask(); return; }
      if (age > TASK_MAX_MS) recycleWanted = true;
      try { ws?.send(pcm); } catch { /* socket dying; close handler reports it */ }
      armIdle();
    },

    async finish() {
      if (closed) return;
      ending = true;
      if (state === 'running' || state === 'opening') {
        await new Promise<void>((resolve) => {
          flushResolve = resolve;
          flushTimer = setTimeout(() => { flushResolve = null; resolve(); }, FLUSH_MS);
          endTask();
        });
      }
      // The last sentence's polish is the only one the user can actually be
      // waiting on — everything before it landed while they were still talking.
      if (polishJobs.size) {
        await Promise.race([
          Promise.allSettled([...polishJobs]),
          new Promise((r) => setTimeout(r, POLISH_DRAIN_MS)),
        ]);
      }
      closed = true;
      teardownSocket();
    },

    close() {
      ending = true;
      closed = true;
      settleFinish();
      teardownSocket();
    },
  };
}
