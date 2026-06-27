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
  // Host-level RAM/swap/load/cpu snapshot → upserts HostStat (resource governance).
  syncHostStat: (stat: any) => post('/api/sync/host-stat', { stat }),
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

  // Global memory — the single shared note the gateway mirrors into this host's
  // ~/.claude/CLAUDE.md so every agent session loads it.
  getGlobalMemory: async (): Promise<{ content: string; enabled: boolean; updatedAt: string | null }> => {
    const r = await get<any>(
      '/api/trpc/globalMemory.get?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? { content: '', enabled: true, updatedAt: null };
  },

  pollChatPending: async (): Promise<{
    sessions: Array<{ id: string; agentName: string; claudeSessionId: string | null; agentDirectory: string | null; isOrchestrator?: boolean }>;
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

  // Idempotent brain convergence — POSTed on gateway startup + a low-freq tick.
  // The dashboard reconciles the machine's orchestrator (re-overlays the dreaming
  // skill via an AgentRequest, ensures the Daily dream cron, triggers the first
  // dream). No-op server-side when there's no orchestrator (Brain stays opt-in).
  ensureBrain: async (): Promise<{ name: string | null }> => {
    const url = `${DASHBOARD_URL}/api/trpc/agents.ensureBrain?batch=1`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify({ '0': { json: null } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ensureBrain → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as any;
    return j?.[0]?.result?.data?.json ?? { name: null };
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
