// Next.js calls register() once per server start. We use it to bring up the
// SystemTask scheduler. See https://nextjs.org/docs/app/guides/instrumentation.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startScheduler } = await import('./src/server/scheduler');
  startScheduler();
}
