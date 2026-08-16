// Live preview — agent-mounted HTML dirs / loopback services, embedded in the
// dashboard's session pane. Two loopback listeners with very different trust:
//   serve (:4180)  — tunneled to https://preview.swaylab.ai; treats every
//                    request as public internet.
//   admin (:4181)  — never tunneled; the local hermit-preview CLI's endpoint.
// Design doc: the "Hermit Live Preview" artifact (2026-08-16).

import { api } from '../api';
import { loadRegistry, sweepExpired } from './registry';
import { dropPreview } from './reload';
import { startPreviewAdmin } from './admin';
import { startPreviewServe } from './serve';

export function startPreviewServers(): void {
  loadRegistry();
  startPreviewServe();
  startPreviewAdmin();
}

/** Hourly: retire registrations idle past the 24h TTL and clear their dashboard column. */
export async function previewSweepTick(): Promise<void> {
  for (const e of sweepExpired()) {
    dropPreview(e.previewId);
    console.log(`[preview] expired ${e.previewId} (session ${e.sessionId})`);
    try {
      await api.syncLivePreview(e.sessionId, null);
    } catch {
      /* column stays stale until the next successful sync; harmless */
    }
  }
}
