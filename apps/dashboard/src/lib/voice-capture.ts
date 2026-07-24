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
// re-prompt (that's left to a future native app).
const WARM_HOLD_MS = 20_000;

// ── Warm mic (module-level, shared across recordings) ───────────────────────
let warm: { stream: MediaStream; ctx: AudioContext } | null = null;
let warmTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;

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

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
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
  const teardown = () => {
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
    scheduleWarmRelease();
  };

  return {
    async stop() {
      if (stopped) return new Blob([], { type: 'audio/wav' });
      teardown();
      const pcm = mergeAndDownsample(chunks, sourceRate, TARGET_RATE);
      return encodeWav(pcm, TARGET_RATE);
    },
    cancel() {
      if (!stopped) teardown();
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
