'use client';

// Browser mic capture for voice input: 16 kHz mono PCM16, emitted as it arrives.
//
// getUserMedia + a Web Audio ScriptProcessorNode pull raw Float32 PCM off the
// mic; each block is downsampled to 16 kHz and handed straight to the caller,
// which streams it to /api/asr. A live RMS level drives the waveform.
// ScriptProcessorNode is deprecated but works everywhere including iOS Safari
// and needs no separate worklet module URL.
//
// WARM MIC: the mic stream + AudioContext are kept alive for a short while after a
// recording (WARM_HOLD_MS) and reused by the next one. Opening the mic device
// (getUserMedia) has real latency — enough to clip the first words — so warming it
// means a rapid second recording starts capturing INSTANTLY. Released on idle or
// when the tab is hidden (so the mic indicator doesn't linger indefinitely).
//
// iOS note: startStreaming() MUST be invoked synchronously inside a user gesture
// (the FAB pointerdown / the PTT keydown) so getUserMedia + AudioContext.resume
// are allowed.

import { isNativeShell, setNativeMicActive } from './native-bridge';

const TARGET_RATE = 16_000;
// Keep the mic warm briefly after a recording so a back-to-back recording starts
// instantly (no getUserMedia device-open latency → no clipped first words). This is
// only for the clip-fix — NOT a workaround for iOS's per-getUserMedia permission
// re-prompt. That one is unfixable from here: in Safari and in an installed PWA the
// prompt returns on every call, and the warm window merely hides it for 20 s. The
// fix lives in the native shell (apps/ios), where the host app answers the capture
// request itself so the web layer stops being asked at all.
const WARM_HOLD_MS = 20_000;

// ── Warm mic (module-level, shared across recordings) ───────────────────────
let warm: { stream: MediaStream; ctx: AudioContext } | null = null;
let warmTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;

// ── Mic permission state ────────────────────────────────────────────────────
// "Would opening the mic RIGHT NOW pop a permission prompt?" — the button needs
// that answer SYNCHRONOUSLY at pointerdown, before it knows whether the touch is
// a press-to-talk or a drag, so the async answer is cached here.
//
// It genuinely changes on its own: iOS never persists a getUserMedia grant. WebKit
// keeps grants in memory (UserMediaPermissionRequestManagerProxy::m_grantedRequests)
// and a watchdog drops them ~10 min after capture stops (24 h while a track is
// live); a reload or a cold app launch starts with none. The Permissions API is
// wired to exactly that state — shouldChangePromptToGrantForMicrophone() answers
// 'granted' iff a live grant matches — so it is the right thing to ask, but the
// answer expires, hence the freshness window below.
export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';
const PERM_FRESH_MS = 20_000;
let micPerm: MicPermission = 'unknown';
let micPermAt = 0;
let permSubscribed = false;

/** True while a mic track from a previous recording is still open (grant is current). */
export function isMicWarm(): boolean {
  return (
    !!warm &&
    warm.ctx.state !== 'closed' &&
    warm.stream.getTracks().some((t) => t.readyState === 'live')
  );
}

/**
 * Last known permission state, synchronously. 'unknown' when the browser can't
 * answer (Permissions API without the 'microphone' name) or the cached answer has
 * gone stale — callers should treat 'unknown' as "can't tell", not as a denial.
 */
export function micPermission(): MicPermission {
  if (isMicWarm()) return 'granted';
  if (micPerm !== 'unknown' && Date.now() - micPermAt > PERM_FRESH_MS) return 'unknown';
  return micPerm;
}

/** Re-ask the browser; safe to call often (cheap, and it drives micPermission()). */
export async function refreshMicPermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    if (!status) return micPerm;
    micPerm = status.state as MicPermission;
    micPermAt = Date.now();
    if (!permSubscribed) {
      permSubscribed = true;
      status.addEventListener('change', () => {
        micPerm = status.state as MicPermission;
        micPermAt = Date.now();
      });
    }
  } catch {
    // Safari before the Permissions API knew 'microphone', Firefox, etc.
  }
  return micPerm;
}

function noteGranted() {
  micPerm = 'granted';
  micPermAt = Date.now();
  lastCaptureAt = Date.now();
  // A stream is open. In the native shell this is what puts iOS's audio session
  // into a category that can actually record.
  setNativeMicActive(true);
}

// How long after a successful capture we still assume the grant is live, when the
// browser won't tell us. Deliberately under WebKit's ~10 min post-capture watchdog.
const CAPTURE_EVIDENCE_MS = 4 * 60_000;
let lastCaptureAt = 0;

/**
 * "Can we open the mic right now WITHOUT a permission prompt?" — the question the
 * button asks on pointerdown, when it still can't tell a press-to-talk from a drag.
 * False means: don't open anything yet, offer an explicit tap-to-allow instead.
 */
export function canOpenMicSilently(): boolean {
  // Inside the native shell the host app answers the capture request itself
  // (WKUIDelegate → .grant), so there is no prompt to protect the user from —
  // and this is the app whose entire reason for existing is not having one.
  // Without this, press-and-hold in the shell demands a redundant "tap to allow"
  // on every cold launch and after every ~10 minutes idle.
  if (isNativeShell()) return true;
  if (isMicWarm()) return true;
  const perm = micPermission();
  if (perm === 'granted') return true;
  if (perm === 'prompt' || perm === 'denied') return false;
  // Browser can't answer (old Safari, Firefox) or the cached answer went stale —
  // fall back to evidence: a capture this recently means the grant is still live.
  return Date.now() - lastCaptureAt < CAPTURE_EVIDENCE_MS;
}

/**
 * Ask for mic access WITHOUT starting a recording — the first-run "tap to allow"
 * step. Must be called straight from a user gesture (a click/pointerup handler):
 * WebKit only treats a request made inside the gesture's own call stack as
 * privileged, and an unprivileged one that was denied before is auto-denied.
 * Leaves the mic warm so the press that follows starts instantly.
 */
export async function requestMicAccess(): Promise<void> {
  await acquireWarm();
  scheduleWarmRelease();
}

function releaseWarm() {
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  if (warm) {
    warm.stream.getTracks().forEach((t) => t.stop());
    void warm.ctx.close();
    warm = null;
    // Hand the audio route back — otherwise the shell keeps other apps ducked.
    setNativeMicActive(false);
  }
}

function scheduleWarmRelease() {
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(releaseWarm, WARM_HOLD_MS);
}

/** Release the warm mic now (call when leaving the chat so it doesn't linger). */
export function releaseWarmMic(): void {
  releaseWarm();
}

async function acquireWarm(): Promise<{ stream: MediaStream; ctx: AudioContext }> {
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; } // recording again — cancel pending release
  if (warm && warm.ctx.state !== 'closed' && warm.stream.getTracks().some((t) => t.readyState === 'live')) {
    return warm;
  }
  releaseWarm(); // stale (device revoked / ctx closed) — start fresh

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    // NotAllowedError is the user (or a policy) saying no — remember it so the
    // button offers the "go enable it in Settings" hint instead of re-prompting.
    if ((e as DOMException)?.name === 'NotAllowedError') {
      micPerm = 'denied';
      micPermAt = Date.now();
    }
    throw e;
  }
  noteGranted();
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') await ctx.resume();
  warm = { stream, ctx };

  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseWarm(); });
    window.addEventListener('pagehide', releaseWarm);
  }
  return warm;
}

// ── Streaming capture (realtime dictation) ──────────────────────────────────
//
// The batch recorder above hoards Float32 until stop(); this one emits 16 kHz
// PCM16 as it goes, ~85 ms per block (one ScriptProcessor buffer), which is what
// the /api/asr socket forwards to DashScope. Same warm-mic machinery, same
// gesture rules — only the sink differs.
//
// TWO THINGS THIS DOES BEYOND FORWARDING:
//
// · A SILENCE GATE. DashScope bills by the audio second, and a dictation bar left
//   open while nobody talks would stream billable nothing. So after SILENCE_TAIL_MS
//   below the speech threshold we stop emitting until sound returns. The tail is
//   deliberately longer than the server's 800 ms sentence-close silence, so the
//   sentence in flight always gets the quiet it needs to close BEFORE the gate
//   shuts — otherwise the last sentence of every paragraph would hang open.
//
// · A FALLBACK BUFFER. Everything emitted since the last mark() is also kept
//   locally, so if the socket dies mid-dictation the words that were in the air
//   are not lost: the widget POSTs them to the batch /api/transcribe instead.
//   mark() is called on every closed sentence, so this is normally a few seconds
//   of audio, not the whole run.

/** RMS below this is "not speech". Same scale as the level callback ÷ 5. */
const SILENCE_RMS = 0.012;
/** Quiet for this long → stop emitting. Must exceed the server's max_sentence_silence. */
const SILENCE_TAIL_MS = 1_500;

export interface VoiceStream {
  /** Audio emitted since the last mark(), as a WAV — the socket-died fallback clip. */
  stop(): Promise<Blob>;
  /** "Everything so far is safely transcribed" — drops it from the fallback clip. */
  mark(): void;
  /** Abort; no Blob, mic released. */
  cancel(): void;
}

interface StreamOpts {
  /** 16 kHz mono PCM16, ~85 ms per call. Not called while the silence gate is shut. */
  onChunk: (pcm: Int16Array) => void;
  onLevel?: (level: number) => void;
  /** Gate transitions — true when we stopped emitting because nobody is talking. */
  onSilence?: (silent: boolean) => void;
  maxMs?: number;
  onAutoStop?: () => void;
}

/**
 * Stateful decimator. The batch path can resample the whole recording at once;
 * a stream cannot, because 4096 input samples is not a whole number of output
 * samples (48 kHz → 16 kHz leaves a remainder every block). The unconsumed tail
 * carries into the next block, so no click is introduced at the seams.
 */
function makeDownsampler(from: number, to: number): (block: Float32Array) => Float32Array {
  if (from === to) return (b) => b;
  const ratio = from / to;
  let carry = new Float32Array(0);
  return (block: Float32Array) => {
    let buf: Float32Array;
    if (carry.length) {
      buf = new Float32Array(carry.length + block.length);
      buf.set(carry, 0);
      buf.set(block, carry.length);
    } else {
      buf = block;
    }
    const outLen = Math.floor(buf.length / ratio);
    const out = new Float32Array(outLen);
    let n = 0;
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      if (end > buf.length) break;
      let sum = 0;
      for (let j = start; j < end; j++) sum += buf[j];
      out[n++] = sum / (end - start);
    }
    const consumed = Math.floor(n * ratio);
    carry = buf.slice(consumed);
    return n === outLen ? out : out.subarray(0, n);
  };
}

function toPcm16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export async function startStreaming(opts: StreamOpts): Promise<VoiceStream> {
  const { stream, ctx } = await acquireWarm();
  if (ctx.state === 'suspended') await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const down = makeDownsampler(ctx.sampleRate, TARGET_RATE);
  let fallback: Float32Array[] = []; // 16 kHz mono, since the last mark()
  let stopped = false;
  let lastLoudAt = Date.now();
  let gated = false;

  const maxMs = opts.maxMs ?? 30 * 60_000;
  const autoTimer = setTimeout(() => { if (!stopped) opts.onAutoStop?.(); }, maxMs);

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    opts.onLevel?.(Math.min(1, rms * 5));

    const now = Date.now();
    if (rms >= SILENCE_RMS) lastLoudAt = now;
    const shouldGate = now - lastLoudAt > SILENCE_TAIL_MS;
    if (shouldGate !== gated) {
      gated = shouldGate;
      opts.onSilence?.(gated);
    }
    if (gated) return;

    const pcm = down(new Float32Array(input));
    if (!pcm.length) return;
    fallback.push(pcm.slice());
    opts.onChunk(toPcm16(pcm));
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  const teardown = (keepWarm: boolean) => {
    stopped = true;
    clearTimeout(autoTimer);
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
      mute.disconnect();
      source.disconnect();
    } catch {
      /* already gone */
    }
    if (keepWarm) scheduleWarmRelease();
    else releaseWarm();
  };

  return {
    async stop() {
      if (!stopped) teardown(true);
      const total = fallback.reduce((n, c) => n + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of fallback) { merged.set(c, off); off += c.length; }
      return encodeWav(merged, TARGET_RATE);
    },
    mark() {
      fallback = [];
    },
    cancel() {
      if (!stopped) teardown(false);
      fallback = [];
    },
  };
}

// Encode mono Float32 PCM as a 16-bit little-endian PCM WAV Blob.
function encodeWav(pcm: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate = rate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bytes/sample
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
