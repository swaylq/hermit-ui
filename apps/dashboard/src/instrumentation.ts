export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Skip scheduler when running as the read-only dashboard. Two probes —
  // env var via bracket access (which Turbopack does not statically inline)
  // plus an fs.existsSync check (truly impossible to inline). Either signal
  // → bail. VPS deploys hit the fs check; dev w/ env var hits the env check.
  const env = process.env as Record<string, string | undefined>;
  if (env['GATEWAY_DRIVEN'] === '1') return;
  const fs = await import('node:fs');
  if (!fs.existsSync('/Users/mac/claudeclaw')) return;

  const { startScheduler } = await import('./server/scheduler');
  startScheduler();
}
