'use client';

import { useState } from 'react';
import { getActiveEntry } from '@/lib/keyring';

export type Scope = { scoped: boolean; agentName: string | null };

// Whether THIS session is a scoped agent-share (its active key is a `shr_` token
// locked to one agent) and which agent. Read once from the active keyring entry;
// safe to read synchronously because AuthGate only mounts its children after
// hydration, so this never runs during SSR. The SERVER is the real boundary — this
// only drives the stripped shell (ScopedSidebar + route bounds).
export function useScope(): Scope {
  const [scope] = useState<Scope>(() => {
    if (typeof window === 'undefined') return { scoped: false, agentName: null };
    const e = getActiveEntry();
    return { scoped: !!e?.scoped, agentName: e?.agentName ?? null };
  });
  return scope;
}
