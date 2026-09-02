// session-host/main.ts — the pm2 entry point for the session host.
//
// A separate pm2 app from the gateway on purpose: `pm2 restart
// hermit-ui-gateway` must not touch it, which is the entire point. See host.ts.
import os from 'node:os';
import path from 'node:path';
import { startSessionHost } from './host';

export function hostSocketPath(): string {
  return process.env.HERMIT_HOST_SOCK || path.join(os.homedir(), '.hermit', 'session-host', 'v1.sock');
}

const host = await startSessionHost({ socketPath: hostSocketPath() });

// SIGTERM is pm2 asking us to stop, and stopping means ending the children —
// nothing can adopt their stdio. The gateway resumes them on its next start.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[host] ${sig}, closing ${host.sessions().length} session(s)`);
    void host.close().then(() => process.exit(0));
  });
}
