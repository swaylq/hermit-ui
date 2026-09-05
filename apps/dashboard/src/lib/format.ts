/**
 * Compact count, k/M/B. Despite the name it has only ever been given TOKEN counts, not
 * bytes — context sizes in `ctx-bar`, daily totals in `usage-sparkline`.
 *
 * The B tier is not decoration: a machine's cache-read tokens run to ~10B over two
 * weeks, and without it that printed as `10641.71M`.
 */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ctxPct(n: number | null | undefined, total = 1_000_000): number {
  if (!n) return 0;
  return Math.min(100, (n / total) * 100);
}

/**
 * How wide the context bar's fill is drawn, as a percentage of its track.
 *
 * Not the same number as `ctxPct`: a bar clamped to a 2% minimum so that a
 * session which has used something reads as a sliver rather than as an empty
 * track. Lives here rather than inside `<CtxBar>` so the iOS port can be held
 * against it — the phone draws the same bar and would otherwise be a second
 * reading of a one-line expression (apps/ios/tools/header-fixture.sh).
 */
export function ctxFill(pct: number): number {
  return Math.max(2, Math.min(100, pct));
}

export function relTime(d: Date | string | null | undefined, now: number = Date.now()): string {
  if (!d) return '-';
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const s = Math.floor((now - t) / 1000);
  if (s < 0) return 'future';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Per-agent palette mapped from a stable hash of the agent name.
// Six warm pastel tones (matches design tokens: sage, blush, lavender, peach, sky, mint).
const AGENT_PALETTES = [
  { from: 'from-emerald-300', to: 'to-teal-400', ring: 'ring-emerald-400/40', text: 'text-emerald-950' },   // sage
  { from: 'from-rose-300',    to: 'to-pink-400', ring: 'ring-rose-400/40',    text: 'text-rose-950' },      // blush
  { from: 'from-violet-300',  to: 'to-purple-400', ring: 'ring-violet-400/40', text: 'text-violet-950' },   // lavender
  { from: 'from-orange-300',  to: 'to-amber-400', ring: 'ring-orange-400/40', text: 'text-orange-950' },    // peach
  { from: 'from-sky-300',     to: 'to-cyan-400', ring: 'ring-sky-400/40',    text: 'text-sky-950' },        // sky
  { from: 'from-lime-300',    to: 'to-green-400', ring: 'ring-lime-400/40',  text: 'text-lime-950' },       // mint
] as const;

export function agentColor(name: string): typeof AGENT_PALETTES[number] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % AGENT_PALETTES.length;
  return AGENT_PALETTES[idx];
}

export function stateColor(state: string | null | undefined, alive: boolean): {
  dot: string;
  text: string;
  bg: string;
  border: string;
} {
  if (!alive) {
    return { dot: 'bg-rose-500', text: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/30' };
  }
  switch (state) {
    case 'running':
      return { dot: 'bg-amber-400', text: 'text-amber-300', bg: 'bg-amber-400/10', border: 'border-amber-400/30' };
    case 'stuck':
      return { dot: 'bg-rose-500', text: 'text-rose-300', bg: 'bg-rose-500/10', border: 'border-rose-500/30' };
    case 'idle':
      return { dot: 'bg-emerald-500', text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' };
    default:
      return { dot: 'bg-zinc-500', text: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-700' };
  }
}
