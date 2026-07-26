'use client';

// Browser mic capture → 16 kHz mono PCM16 WAV, for the voice-input feature.
//
// getUserMedia + a Web Audio ScriptProcessorNode pull raw Float32 PCM off the
// mic; on stop() we merge + downsample to 16 kHz mono and encode a WAV Blob —
// exactly what /api/transcribe → OpenRouter/DashScope expects. A live RMS level
// drives the HUD waveform. ScriptProcessorNode is deprecated but works everywhere
// including iOS Safari and needs no separate worklet module URL.
//
// WARM MIC: the mic stream + AudioContext are kept alive for a short while after a
// recording (WARM_HOLD_MS) and reused by the next one. Opening the mic device
// (getUserMedia) has real latency — enough to clip the first words — so warming it
// means a rapid second recording starts capturing INSTANTLY. Released on idle or
// when the tab is hidden (so the mic indicator doesn't linger indefinitely).
//
// iOS note: startRecording() MUST be invoked synchronously inside a user gesture
// (the FAB pointerdown / the PTT keydown) so getUserMedia + AudioContext.resume
// are allowed.

export interface VoiceRecorder {
  /** Stop capture and resolve the recording as a 16 kHz mono WAV Blob. */
  stop(): Promise<Blob>;
  /** Abort capture without producing a Blob (the warm mic is kept for reuse). */
  cancel(): void;
}

interface StartOpts {
  onLevel?: (level: number) => void; // 0..1 RMS envelope, ~ every 85 ms
  maxMs?: number; // auto-stop ceiling (default 60 s)
  onAutoStop?: () => void; // fired when maxMs is hit (the widget should then stop())
}

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

export async function startRecording(opts: StartOpts = {}): Promise<VoiceRecorder> {
  const { stream, ctx } = await acquireWarm();
  if (ctx.state === 'suspended') await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // Route processor → muted gain → destination: the graph must reach a
  // destination for onaudioprocess to fire, but gain 0 avoids mic feedback.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const chunks: Float32Array[] = [];
  const sourceRate = ctx.sampleRate;
  let stopped = false;

  const maxMs = opts.maxMs ?? 60_000;
  const autoTimer = setTimeout(() => { if (!stopped) opts.onAutoStop?.(); }, maxMs);

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    if (opts.onLevel) {
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      opts.onLevel(Math.min(1, Math.sqrt(sum / input.length) * 5));
    }
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  // Detach this recording's nodes but KEEP the stream + ctx warm for the next one.
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
    // A real recording keeps the mic warm for the next one; a cancel (drag /
    // discard) releases it immediately so the mic indicator doesn't linger.
    if (keepWarm) scheduleWarmRelease();
    else releaseWarm();
  };

  return {
    async stop() {
      if (stopped) return new Blob([], { type: 'audio/wav' });
      teardown(true);
      const pcm = mergeAndDownsample(chunks, sourceRate, TARGET_RATE);
      return encodeWav(pcm, TARGET_RATE);
    },
    cancel() {
      if (!stopped) teardown(false);
    },
  };
}

// Concatenate the captured chunks and resample to `to` Hz with a cheap averaging
// filter (mild anti-alias vs plain decimation). Mono in, mono out.
function mergeAndDownsample(chunks: Float32Array[], from: number, to: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  if (from === to || total === 0) return merged;

  const ratio = from / to;
  const outLen = Math.floor(merged.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(merged.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += merged[j];
    out[i] = end > start ? sum / (end - start) : merged[start] || 0;
  }
  return out;
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
