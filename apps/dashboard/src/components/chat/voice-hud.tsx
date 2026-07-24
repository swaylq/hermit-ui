'use client';

// Aurora-glass HUD for the voice mic — a small Canvas capsule ported (in spirit)
// from Keyo's VoiceHUD.swift: three traveling sine waves + a slow envelope under
// a flowing multi-colour gradient "curtain", the crest reacting to the live mic
// level. States: recording (blue, level-reactive) · transcribing (blue + a white
// sweep) · error (ember red, collapsed). No ctx.filter/blur — unsupported on iOS
// Safari; the gradient + alpha carry the glow instead.

import { useEffect, useRef } from 'react';

export type HudPhase = 'recording' | 'transcribing' | 'error';

const AURORA = ['#9433F2', '#124DFF', '#1F99FA', '#2EDB9E'];
const EMBER = ['#9E1A2E', '#EB4D42', '#FA853D', '#EDB06B'];

export function VoiceHUD({ phase, level }: { phase: HudPhase; level: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  const phaseRef = useRef<HudPhase>(phase);
  const envRef = useRef(0); // fast-attack / slow-decay level envelope
  levelRef.current = level;
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = (canvas.width = Math.round(canvas.clientWidth * dpr) || 192);
    const H = (canvas.height = Math.round(canvas.clientHeight * dpr) || 40);
    let raf = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const ph = phaseRef.current;
      const target = ph === 'recording' ? levelRef.current : ph === 'transcribing' ? 0.22 : 0.08;
      envRef.current = Math.max(target, envRef.current * 0.9);
      const amp01 = Math.min(1, envRef.current);
      const colors = ph === 'error' ? EMBER : AURORA;

      ctx.clearRect(0, 0, W, H);
      const baseline = H * 0.5;
      const ampPx = (baseline - 3 * dpr) * amp01;

      // Flowing palette: cycle the colours and translate over time (7 s → left).
      const flow = (t / 6) % 1;
      const grad = ctx.createLinearGradient(-W * flow, 0, W * 2 - W * flow, 0);
      const cyc = [...colors, ...colors, colors[0]];
      cyc.forEach((c, i) => grad.addColorStop(i / (cyc.length - 1), c));

      const waveY = (x: number) => {
        const u = x / W;
        const w1 = 0.55 * Math.sin(u * Math.PI * 4.2 + t * 2.4);
        const w2 = 0.3 * Math.sin(u * Math.PI * 7.4 - t * 3.1 + 1.3);
        const w3 = 0.15 * Math.sin(u * Math.PI * 10.6 + t * 4.2 + 2.6);
        const env = 0.65 + 0.35 * Math.sin(u * Math.PI * 1.8 + t * 0.7);
        return baseline - (w1 + w2 + w3) * env * ampPx;
      };

      // Curtain (wave → bottom), filled with the flowing palette.
      ctx.beginPath();
      ctx.moveTo(0, waveY(0));
      for (let x = 2; x <= W; x += 2) ctx.lineTo(x, waveY(x));
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = grad;
      ctx.fill();

      // Crest line.
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(0, waveY(0));
      for (let x = 2; x <= W; x += 2) ctx.lineTo(x, waveY(x));
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = grad;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Transcribing: a white highlight sweeps left → right along the curtain.
      if (ph === 'transcribing') {
        const s = ((t / 1.4) % 1) * 1.5 - 0.25;
        const cx = W * s;
        const half = W * 0.18;
        const sg = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
        sg.addColorStop(0, 'rgba(255,255,255,0)');
        sg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, W, H);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const label = phase === 'recording' ? '录音中' : phase === 'transcribing' ? '识别中' : '出错了';
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1.5 shadow-lg backdrop-blur-md">
      <canvas ref={canvasRef} className="h-5 w-24" />
      <span className="whitespace-nowrap text-xs font-medium text-white/90">{label}</span>
    </div>
  );
}
