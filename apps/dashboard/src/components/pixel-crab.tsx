// Pixel-art hermit crab — the Hermit brand mark, designed to stay legible at the
// ~20px sidebar size where the detailed crab logo would turn to mush. Each grid
// cell is one SVG pixel (shape-rendering: crispEdges keeps the edges sharp).

const ROWS = [
  '      kkkk      ',
  '    kkCCCCkk    ',
  '   kCCCCCCCCk   ',
  '  kCCCCmCCCCCk  ',
  '  kCCCCmCCCCCk  ',
  '  kCCmmmmmCCCk  ',
  '  kCCCCmCCCCCk  ',
  '  kCCCCmCCCCCk  ',
  '  kCCCCCCCCCCk  ',
  '  kbBBBBBBBBbk  ',
  '  kbBeBBBBeBbk  ',
  ' kbBBBBBBBBBBbk ',
  'kbBBkBBBBBBkBBbk',
  'k bkbBkbbkBbkb k',
  ' b k b kk b k b ',
  '      k  k      ',
];

const C: Record<string, string> = {
  k: '#3d2c20', // outline
  C: '#d96a4d', // coral shell
  m: '#f5e7d0', // cream starburst
  B: '#9b6340', // brown body
  b: '#7a4d31', // brown shadow / legs
  e: '#f5e7d0', // eye
};

export function PixelCrab({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} shapeRendering="crispEdges" aria-hidden="true">
      {ROWS.map((row, y) =>
        [...row].map((ch, x) =>
          C[ch] ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={C[ch]} /> : null,
        ),
      )}
    </svg>
  );
}
