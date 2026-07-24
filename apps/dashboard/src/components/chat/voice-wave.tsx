'use client';

// The aurora waveform that lives INSIDE the mic button. A fill-the-parent canvas
// (resize-aware, so it grows with the button's expand animation): three traveling
// sine waves under a flowing multi-colour gradient curtain, the crest reacting to
// the live mic level. States: recording (blue-cyan, level-reactive) · transcribing
// (a white highlight sweeps across) · error (ember). No ctx.filter — unsupported
// on iOS Safari; gradient + alpha carry the glow. Chrome (glass, shape) is the
// button's job — this draws only the wave.

import { useEffect, useRef } from 'react';

export type WavePhase = 'recording' | 'transcribing' | 'error';

// Refined, slightly desaturated blue→cyan→teal — reads as premium on a dark glass.
const AURORA = ['#4f7bff', '#38bdf8', '#2dd4bf', '#818cf8'];
const EMBER = ['#f43f5e', '#fb7185', '#fb923c', '#f59e0b'];

export function VoiceWave({ phase, level }: { phase: WavePhase; level: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  const phaseRef = useRef<WavePhase>(phase);
  const envRef = useRef(0);
  levelRef.current = level;
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let raf = 0;
    const start = performance.now();

    const draw = (now: number) => {
      // Match the backing store to the (animating) CSS size so the wave fills the
      // button as it expands / collapses.
      const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      const W = canvas.width;
      const H = canvas.height;

      const t = (now - start) / 1000;
      const ph = phaseRef.current;
      const target = ph === 'recording' ? levelRef.current : ph === 'transcribing' ? 0.26 : 0.1;
      envRef.current = Math.max(target, envRef.current * 0.88); // fast attack, slow decay
      const amp01 = Math.min(1, envRef.current);
      const colors = ph === 'error' ? EMBER : AURORA;

      ctx.clearRect(0, 0, W, H);
      const baseline = H * 0.5;
      const ampPx = (baseline - 3 * dpr) * (0.14 + 0.86 * amp01); // keep a faint idle line

      const flow = (t / 5) % 1;
      const grad = ctx.createLinearGradient(-W * flow, 0, W * 2 - W * flow, 0);
      const cyc = [...colors, ...colors, colors[0]];
      cyc.forEach((c, i) => grad.addColorStop(i / (cyc.length - 1), c));

      const waveY = (x: number) => {
        const u = x / W;
        const w1 = 0.55 * Math.sin(u * Math.PI * 4.2 + t * 2.4);
        const w2 = 0.3 * Math.sin(u * Math.PI * 7.4 - t * 3.1 + 1.3);
        const w3 = 0.15 * Math.sin(u * Math.PI * 10.6 + t * 4.2 + 2.6);
        const env = 0.6 + 0.4 * Math.sin(u * Math.PI * 1.8 + t * 0.7);
        return baseline - (w1 + w2 + w3) * env * ampPx;
      };

      // Filled curtain (wave → bottom).
      ctx.beginPath();
      ctx.moveTo(0, waveY(0));
      for (let x = 2; x <= W; x += 2) ctx.lineTo(x, waveY(x));
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = grad;
      ctx.fill();

      // Crest highlight.
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(0, waveY(0));
      for (let x = 2; x <= W; x += 2) ctx.lineTo(x, waveY(x));
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = grad;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Transcribing: a white highlight sweeps left → right.
      if (ph === 'transcribing') {
        const s = ((t / 1.3) % 1) * 1.5 - 0.25;
        const cx = W * s;
        const half = W * 0.2;
        const sg = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
        sg.addColorStop(0, 'rgba(255,255,255,0)');
        sg.addColorStop(0.5, 'rgba(255,255,255,0.5)');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, W, H);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="h-full w-full" />;
}
