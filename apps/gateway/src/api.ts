import { DASHBOARD_URL, ASST_KEY } from './config';
import { dashboardBackedOff, noteDashboardSuccess, noteDashboardFailure } from './dashboard-http';

// Hard ceiling on every dashboard HTTP call. Without it a hung connection (a
// dashboard restart / network blip) never settles, and any tick that holds a
// `busy` guard across the await wedges FOREVER — silently logging "ok in 0ms"
// while doing nothing. The timeout turns a hang into a retryable error.
const HTTP_TIMEOUT_MS = 30_000;

function isSelfInflicted(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.code
    ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === 'UND_ERR_DESTROYED';
}

/**
 * Every dashboard call goes through here so the breaker sees the whole picture.
 *
 * Only TRANSPORT outcomes are reported. A 4xx/5xx means the connection is fine
 * and the dashboard answered — rotating it would be wrong, and treating an
 * application error as a transport one would trip the breaker on things like a
 * single oversized skill tree 500ing. `fetch` itself rejecting (DNS, refused,
 * reset, timeout, a poisoned HTTP/2 connection) is the case worth backing off.
 */
async function dashboardFetch(url: string, init: RequestInit): Promise<Response> {
  if (dashboardBackedOff()) throw new Error('dashboard calls paused (backing off after repeated transport failures)');
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e) {
    // UND_ERR_DESTROYED means WE tore the pool down under this request while
    // rotating the connection. Self-inflicted, and says nothing about the
    // dashboard — feeding it back to the breaker is how one failure turns into
    // a rotation cascade.
    if (!isSelfInflicted(e)) noteDashboardFailure();
    throw e;
  }
  noteDashboardSuccess();
  return r;
}

async function post(path: string, body: unknown) {
  const r = await dashboardFetch(`${DASHBOARD_URL}${path}`, {
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
  const r = await dashboardFetch(`${DASHBOARD_URL}${path}`, {
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
  // `replaceSince` (first batch of a run only) tells the dashboard to drop every
  // bucket from that instant on before taking these rows — the window is a snapshot,
  // not an accumulation. See collect/usage.ts:usageWindowStart.
  syncUsage: (items: any[], replaceSince?: string) =>
    post('/api/sync/usage', replaceSince ? { items, replaceSince } : { items }),
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

  // `runtime`/`runtimeMode` are the dashboard's already-resolved answer (session's
  // own choice, else the agent's default) and are typed here because every caller
  // needs BOTH: the mode picks the engine, so a runtimeFor() given only the kind
  // hands an omp session pi's runtime — which owns a different handle map and so
  // reports no context at all. That was a live bug; the type is what stops it
  // coming back as an untyped `as` cast at the next call site.
  pollChatPending: async (): Promise<{
    sessions: Array<{
      id: string; agentName: string; claudeSessionId: string | null;
      agentDirectory: string | null; isOrchestrator?: boolean;
      runtime?: string | null; runtimeProvider?: string | null;
      runtimeModel?: string | null; runtimeMode?: string | null;
    }>;
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

  // ── Hibernation (resource governance) ───────────────────────────────────────
  // Manual hibernate requests (context-menu Hibernate). Kill pane → ackHibernated.
  pollHibernations: async (): Promise<Array<{ id: string }>> => {
    const r = await get<any>(
      '/api/trpc/chat.pollHibernations?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  // Idle sessions the dashboard deems safe to auto-reap (empty if idleReapHours
  // is null). The gateway re-checks the live pane (working/exists) before killing.
  pollReapCandidates: async (): Promise<Array<{ id: string }>> => {
    const r = await get<any>(
      '/api/trpc/chat.pollReapCandidates?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackHibernated: async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    const url = `${DASHBOARD_URL}/api/trpc/chat.ackHibernated?batch=1`;
    const body = { '0': { json: { sessionIds } } };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ackHibernated → ${r.status}`);
  },

  // ── Brain dispatch-watcher (docs/brain-design.md Phase 2) ───────────────────
  // Heartbeat for the reactive dispatch loop: the dashboard owns all the data
  // (session state, interactions, messages), so the whole watcher runs server-side
  // as one filtered DB pass. We just tick it and log what it poked.
  runDispatchWatch: async (): Promise<{ scanned: number; poked: number }> => {
    const j = await post('/api/trpc/chat.runDispatchWatch?batch=1', { '0': { json: null } });
    return j?.[0]?.result?.data?.json ?? { scanned: 0, poked: 0 };
  },

  // ── Brain takeover-watcher (docs/brain-takeover-design.md) ──────────────────
  // Same shape as the dispatch watcher, for conversations the human handed to the
  // Brain. There are no turn/time caps to sweep any more (see lib/takeover.ts —
  // being stopped mid-job is what this feature exists to prevent), so `ended` is
  // just the takeovers released this pass because their session closed.
  runTakeoverWatch: async (): Promise<{ scanned: number; poked: number; ended: number }> => {
    const j = await post('/api/trpc/chat.runTakeoverWatch?batch=1', { '0': { json: null } });
    return j?.[0]?.result?.data?.json ?? { scanned: 0, poked: 0, ended: 0 };
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

  // Machine-level pi runtime config (hyqubit endpoint + image recognition),
  // edited on Settings → Pi Runtime. The gateway merges it over its own .env.
  pollPiConfig: async (): Promise<unknown> => {
    const r = await get<any>(
      '/api/trpc/machines.pollPiConfig?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r?.[0]?.result?.data?.json ?? null;
  },

  // Write the machine's pi config. Used once at startup to seed it from the
  // legacy .env knobs — see seedPiConfigFromEnv.
  setPiConfig: async (config: unknown): Promise<void> => {
    await post('/api/trpc/machines.setPiConfig?batch=1', { 0: { json: { config } } });
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

  // ── Knowledge bases (materialize attached KBs as skills) ─────────────────────
  // Pending materialize/remove requests joined with each agent's directory; the
  // gateway writes <agent>/.claude/skills/kb-<slug>/, then acks. Polled ~3s.
  pollKnowledgeRequests: async (): Promise<
    Array<{ id: string; agentName: string; slug: string; kind: string; payload: any; agentDirectory: string | null }>
  > => {
    const r = await get<any>(
      '/api/trpc/knowledge.pollRequests?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  // Full attached-KB snapshot for the startup reconcile (materialize all + prune orphans).
  // KB startup reconcile (P3-1): fetch the lightweight manifest (per-base
  // contentUpdatedAt, no docs' markdown) first, diff it against on-disk markers,
  // then fetch full content only for the changed subset via
  // listKnowledgeMaterialization(items) — instead of re-shipping every base's
  // content on every restart.
  listKnowledgeManifest: async (): Promise<
    Array<{ agentName: string; agentDirectory: string | null; slug: string; name: string; contentUpdatedAt: string }>
  > => {
    const r = await get<any>(
      '/api/trpc/knowledge.materializationManifestForMachine?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: null } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },
  listKnowledgeMaterialization: async (
    items?: Array<{ agentName: string; slug: string }>,
  ): Promise<
    Array<{ agentName: string; agentDirectory: string | null; slug: string; name: string; intro: string; contentUpdatedAt: string; docs: Array<{ filename: string; title: string; content: string }> }>
  > => {
    const input = items ? { items } : null;
    const r = await get<any>(
      '/api/trpc/knowledge.materializationForMachine?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: input } })),
    );
    return r[0]?.result?.data?.json ?? [];
  },

  ackKnowledgeRequest: async (body: { id: string; status: 'done' | 'error'; error?: string }) => {
    const url = `${DASHBOARD_URL}/api/trpc/knowledge.ackRequest?batch=1`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': ASST_KEY },
      body: JSON.stringify({ '0': { json: body } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ackKnowledgeRequest → ${r.status}`);
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
