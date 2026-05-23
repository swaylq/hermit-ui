// Cached snapshot: runs once per TTL across concurrent callers.
//
// On VPS (GATEWAY_DRIVEN=1) the dashboard reads filesystem-derived state from
// the database exclusively — a Mac-side gateway POSTs fresh state via
// /api/sync/*. In that mode this function is a no-op so the tRPC routes that
// call it don't try to probe a filesystem that doesn't exist on the host.
import { collectAgents } from './agents';
import { collectLaunchAgents } from './launchAgents';

const TTL_MS = 5000;
const GATEWAY_DRIVEN = process.env.GATEWAY_DRIVEN === '1';
let lastRun: Record<string, number> = {};
let pending: Record<string, Promise<void> | null> = {};

export async function ensureSnapshot(machineId: string) {
  if (GATEWAY_DRIVEN) return;
  if (Date.now() - (lastRun[machineId] ?? 0) < TTL_MS) return;
  if (pending[machineId]) return pending[machineId]!;

  pending[machineId] = (async () => {
    try {
      await Promise.all([collectAgents(machineId), collectLaunchAgents(machineId)]);
      lastRun[machineId] = Date.now();
    } finally {
      pending[machineId] = null;
    }
  })();

  return pending[machineId];
}
