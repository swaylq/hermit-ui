import { DASHBOARD_URL, ASST_KEY } from './config';

// Hard ceiling on every dashboard HTTP call. Without it a hung connection (a
// dashboard restart / network blip) never settles, and any tick that holds a
// `busy` guard across the await wedges FOREVER — silently logging "ok in 0ms"
// while doing nothing. The timeout turns a hang into a retryable error.
const HTTP_TIMEOUT_MS = 30_000;

async function post(path: string, body: unknown) {
  const r = await fetch(`${DASHBOARD_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${DASHBOARD_URL}${path}`, {
    headers: { 'x-asst-key': ASST_KEY },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export const api = {
  syncAgents: (agents: any[]) => post('/api/sync/agents', { agents }),
  syncSessionSnapshots: (items: any[]) => post('/api/sync/session-snapshot', { items }),
  syncUsage: (items: any[]) => post('/api/sync/usage', { items }),
  syncUsageWindows: (items: any[]) => post('/api/sync/usage-window', { items }),
  // Real Claude Max plan consumption scraped from `claude /usage` (the only
  // source for the true 5h/weekly window %; ccusage is a cost estimate).
  syncPlanUsage: (planUsage: any) => post('/api/sync/plan-usage', { planUsage }),

  // ── Cron jobs (gateway cron-runner) ───────────────────────────────────────
  // Enabled crons joined with their agent's on-disk directory; the runner fires
  // the due ones via tmux + claude. Mirrors pollChatPending's directory join.
  listCrons: async (): Promise<any[]> => {
    const r = await get<any>(
      '/api/trpc/cron.listForGateway?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },
  // Record a run. phase:'start' creates a CronRun(running) + stamps lastFire /
  // nextFire and returns { runId }; phase:'finish' closes it with the result.
  cronRun: (body: any) => post('/api/sync/cron-run', body),

  pollChatPending: async (): Promise<{
    sessions: Array<{ id: string; agentName: string; claudeSessionId: string | null; agentDirectory: string | null }>;
    messages: Array<{ id: string; sessionId: string; role: string; content: any; createdAt: string }>;
  }> => {
    const r = await get<any>(
      '/api/trpc/chat.pollPending?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? { sessions: [], messages: [] };
  },

  ackChatDelivered: async (messageIds: string[]) => {
    if (messageIds.length === 0) return;
    const url = `${DASHBOARD_URL}/api/trpc/chat.ackDelivered?batch=1`;
    const body = { '0': { json: { messageIds } } };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ackChatDelivered → ${r.status}`);
  },

  pollChatCancellations: async (): Promise<Array<{ id: string; cancelRequestedAt: string }>> => {
    const r = await get<any>(
      '/api/trpc/chat.pollCancellations?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackChatCancel: async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    const url = `${DASHBOARD_URL}/api/trpc/chat.ackCancel?batch=1`;
    const body = { '0': { json: { sessionIds } } };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ackChatCancel → ${r.status}`);
  },

  pollSessionRestarts: async (): Promise<Array<{ id: string; restartRequestedAt: string }>> => {
    const r = await get<any>(
      '/api/trpc/chat.pollSessionRestarts?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackSessionRestart: async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    const url = `${DASHBOARD_URL}/api/trpc/chat.ackSessionRestart?batch=1`;
    const body = { '0': { json: { sessionIds } } };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ackSessionRestart → ${r.status}`);
  },

  // ── Agent lifecycle (create/delete/edit) round-trip ─────────────────────
  // Returns one row per pending AgentRequest, joined with the agent's stored
  // directory (null if the agent doesn't exist yet — only happens between
  // requestCreate's transaction inserting Agent + AgentRequest, and us picking
  // both up, so in practice always set for delete/edit; null for fresh create
  // while gateway hasn't scaffolded yet).
  pollAgentRequests: async (): Promise<Array<{ id: string; kind: string; agentName: string; persona: string | null; target: string | null; content: string | null; refs: Array<{ path: string; content: string }> | null; agentDirectory: string | null }>> => {
    const r = await get<any>(
      '/api/trpc/agents.pollRequests?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  // Source-of-truth list of {name, directory} the dashboard knows about. The
  // gateway's pushAgents tick reads markdowns from each `directory` and pushes
  // content via syncAgents. No filesystem scan — DB is leader.
  listAgentDirectories: async (): Promise<Array<{ name: string; directory: string | null }>> => {
    const r = await get<any>(
      '/api/trpc/agents.listForGateway?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackAgentRequest: async (body: { id: string; status: 'done' | 'error'; error?: string }) => {
    const url = `${DASHBOARD_URL}/api/trpc/agents.ackRequest?batch=1`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify({ '0': { json: body } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ackAgentRequest → ${r.status}`);
  },

  // ── Machine-level ops (upgrade claude / restart all sessions) round-trip ─────
  pollMachineRequests: async (): Promise<Array<{ id: string; kind: string }>> => {
    const r = await get<any>(
      '/api/trpc/machines.pollRequests?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackMachineRequest: async (body: { id: string; status: 'running' | 'needs-human' | 'done' | 'error'; output?: string; error?: string }) => {
    const url = `${DASHBOARD_URL}/api/trpc/machines.ackRequest?batch=1`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify({ '0': { json: body } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ackMachineRequest → ${r.status}`);
  },

  // Read-once claim of a login request's sanitized account payload. The dashboard
  // NULLs it server-side in the same call, so this returns the secrets exactly
  // once. null ⇒ nothing to claim (already wiped / not a login request).
  claimLoginPayload: async (
    id: string,
  ): Promise<{ email: string; mailToken: string; emailPassword: string | null } | null> => {
    const url = `${DASHBOARD_URL}/api/trpc/machines.claimLoginPayload?batch=1`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify({ '0': { json: { id } } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`claimLoginPayload → ${r.status}`);
    const j = (await r.json()) as any;
    return j[0]?.result?.data?.json ?? null;
  },

  // Latest login row for this machine — the cancel tick reads it to notice a
  // dashboard-side manual reset (status flipped to error/done out from under us).
  loginStatus: async (): Promise<{ id: string; status: string } | null> => {
    const r = await get<any>(
      '/api/trpc/machines.loginStatus?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? null;
  },

  // ── File Station (large-file delivery) round-trip ───────────────────────────
  pollFileTransfers: async (): Promise<
    Array<{ id: string; filename: string; destPath: string; size: number; unzip: boolean }>
  > => {
    const r = await get<any>(
      '/api/trpc/fileStation.pollPending?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },
  ackFileTransfer: async (body: { id: string; status: 'running' | 'done' | 'error'; error?: string }) => {
    const r = await fetch(`${DASHBOARD_URL}/api/trpc/fileStation.ack?batch=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify({ '0': { json: body } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ackFileTransfer → ${r.status}`);
  },
  // Raw download — caller streams `.body` to disk. 10-min ceiling for big files.
  downloadFileTransfer: async (id: string): Promise<Response> => {
    const r = await fetch(`${DASHBOARD_URL}/api/file-station/download/${id}`, {
      headers: { 'x-asst-key': ASST_KEY },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!r.ok) throw new Error(`downloadFileTransfer → ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return r;
  },

  // ── Machine-global skills (~/.claude/skills/) round-trip ────────────────────
  // syncGlobalSkills pushes the full scanned set (filesystem is leader);
  // poll/ack mirror the agent lifecycle for dashboard-queued create/edit/delete.
  syncGlobalSkills: (skills: any[]) => post('/api/sync/global-skills', { skills }),

  pollGlobalSkillRequests: async (): Promise<Array<{ id: string; kind: string; skillName: string; content: string | null; refs: Array<{ path: string; content: string }> | null }>> => {
    const r = await get<any>(
      '/api/trpc/skills.pollRequests?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackGlobalSkillRequest: async (body: { id: string; status: 'done' | 'error'; error?: string }) => {
    const url = `${DASHBOARD_URL}/api/trpc/skills.ackRequest?batch=1`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify({ '0': { json: body } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ackGlobalSkillRequest → ${r.status}`);
  },

  syncChatMessages: async (
    items: Array<{
      sessionId: string;
      role: string;
      content: any;
      externalId?: string | null;
      claudeSessionId?: string | null;
    }>,
  ) => {
    if (items.length === 0) return;
    return post('/api/sync/chat-message', { items });
  },
};
