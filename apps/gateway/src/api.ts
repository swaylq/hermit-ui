import { DASHBOARD_URL, ASST_KEY } from './config';

async function post(path: string, body: unknown) {
  const r = await fetch(`${DASHBOARD_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${DASHBOARD_URL}${path}`, {
    headers: { 'x-asst-key': ASST_KEY },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export const api = {
  syncAgents: (agents: any[]) => post('/api/sync/agents', { agents }),
  syncAgentSnapshots: (items: any[]) => post('/api/sync/agent-snapshot', { items }),
  syncLaunchAgents: (items: any[]) => post('/api/sync/launchagents', { items }),
  syncUsage: (items: any[]) => post('/api/sync/usage', { items }),
  syncUsageWindows: (items: any[]) => post('/api/sync/usage-window', { items }),
  taskResult: (body: any) => post('/api/sync/task-result', body),

  // Reuse dashboard's tRPC for read queries. Url shape per @trpc/server v11.
  listSystemTasks: async (): Promise<any[]> => {
    const r = await get<any>(
      '/api/trpc/tasks.systemList?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: {} } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  listPendingAgentActions: async (): Promise<Array<{ id: string; name: string; pid: number | null }>> => {
    const r = await get<any>(
      '/api/trpc/agents.pendingActions?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackAgentAction: async (id: string, state: 'started' | 'done' | 'failed') => {
    const url = `${DASHBOARD_URL}/api/trpc/agents.ackAction?batch=1`;
    const body = { '0': { json: { id, state } } };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ackAction ${state} → ${r.status}`);
  },

  pollChatPending: async (): Promise<{
    sessions: Array<{ id: string; agentName: string; claudeSessionId: string | null }>;
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
