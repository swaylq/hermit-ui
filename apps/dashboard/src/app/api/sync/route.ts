// /api/sync/* receives data pushed by the Mac-side gateway. Auth via X-Asst-Key
// (same key the browser uses). The gateway is the sole writer for Agent, Cron,
// and UsageHourly tables on VPS. Browser reads only.
//
// Routes (POST):
//   /api/sync/agents          body: { agents: [...] }
//   /api/sync/usage           body: { items: [...] }
//   /api/sync/cron-run        body: { phase, cronId, ... }
//
// All endpoints return { ok: true, updated: N } on success.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveMachineByKey } from '@/server/auth';

// Auth shares the tRPC resolver + cache (prefix-filtered bcrypt, see
// ../../../server/auth). The OLD path here did a full-table `findMany()` + a
// bcrypt against EVERY machine row on EVERY sync — and the gateway hits
// /api/sync/chat-message on every transcript event, so an active turn ran that
// full-table loop dozens of times a second, saturating the single event loop
// and starving every concurrent request (the ~30s chat-poll stalls in bursts).
async function resolveMachine(req: NextRequest) {
  return resolveMachineByKey(req.headers.get('x-asst-key') ?? '');
}

// Agent is now PURELY static (no runtime fields). The gateway pushes the
// folder's IDENTITY/USER/AGENTS/TOOLS markdowns + skill names + memory
// summary. Runtime (pid/alive/ctx/etc.) lives on ChatSession; pushed via
// /api/sync/session-snapshot.
const AgentInput = z.object({
  name: z.string(),
  directory: z.string().nullable().optional(),
  identityText: z.string().nullable().optional(),
  userText: z.string().nullable().optional(),
  agentsText: z.string().nullable().optional(),
  toolsText: z.string().nullable().optional(),
  evolutionLessons: z.string().nullable().optional(),
  skillNames: z.array(z.string()).optional(),
  skills: z.array(z.object({
    name: z.string(),
    content: z.string(),
    refs: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  })).optional(),
  evolutionFiles: z.array(z.object({ path: z.string(), content: z.string().nullable() })).optional(),
  memoryFiles: z.array(z.object({ path: z.string(), content: z.string().nullable() })).optional(),
  memorySummary: z.string().nullable().optional(),
});

// Machine-global skill pushed from the gateway's ~/.claude/skills/ scan. The
// filesystem is the source of truth — the sync route upserts what's pushed and
// deletes any rows for this machine that are absent from the push.
const GlobalSkillInput = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  // Gateway now sends the full skill tree as { path, content }; `name` kept
  // optional for the legacy references/*.md shape during the rollout.
  refs: z.array(z.object({ path: z.string().optional(), name: z.string().optional(), content: z.string() })).optional(),
  source: z.string().optional(),
  isBundle: z.boolean().optional(),
  subSkills: z.array(z.string()).optional(),
  fileCount: z.number().int().optional(),
});

// Real Claude Max plan consumption scraped from `claude /usage` by the gateway.
const PlanUsageInput = z.object({
  sessionPct: z.number().int().nullable().optional(),
  weekPct: z.number().int().nullable().optional(),
  weekSonnetPct: z.number().int().nullable().optional(),
  sessionResetText: z.string().nullable().optional(),
  weekResetText: z.string().nullable().optional(),
  capturedAt: z.string().optional(),
});

const UsageInput = z.object({
  agentName: z.string(),
  hourBucket: z.string().datetime(),
  cost: z.number(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  cacheCreationTokens: z.number().int().optional(),
  cacheReadTokens: z.number().int().optional(),
  sessions: z.number().int().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  // Fallback handler — actual routes are co-located in /api/sync/<thing>/route.ts
  return NextResponse.json({ error: 'use /api/sync/<thing>' }, { status: 404 });
}

export { resolveMachine, AgentInput, GlobalSkillInput, PlanUsageInput, UsageInput };
