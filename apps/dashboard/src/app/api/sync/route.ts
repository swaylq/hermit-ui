// /api/sync/* receives data pushed by the Mac-side gateway. Auth via X-Asst-Key
// (same key the browser uses). The gateway is the sole writer for Agent,
// LaunchAgentRecord, and UsageHourly tables on VPS. Browser reads only.
//
// Routes (POST):
//   /api/sync/agents          body: { agents: [...] }
//   /api/sync/launchagents    body: { items: [...] }
//   /api/sync/usage           body: { items: [...] }
//   /api/sync/task-result     body: { id, status, output, durationMs, happySessionId? }
//
// All endpoints return { ok: true, updated: N } on success.

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/server/db';

async function resolveMachine(req: NextRequest) {
  const key = req.headers.get('x-asst-key') ?? '';
  if (!key) return null;
  // bcrypt the key prefix to find the machine (mirrors the trpc machineProcedure).
  const machines = await prisma.machine.findMany();
  for (const m of machines) {
    if (await bcrypt.compare(key, m.keyHash)) {
      await prisma.machine.update({ where: { id: m.id }, data: { lastSeen: new Date() } });
      return m;
    }
  }
  return null;
}

const AgentInput = z.object({
  name: z.string(),
  pid: z.number().int().nullable().optional(),
  alive: z.boolean().optional(),
  state: z.string().nullable().optional(),
  contextTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  lastActivity: z.string().datetime().nullable().optional(),
  transcriptPath: z.string().nullable().optional(),
});

const LaunchAgentInput = z.object({
  label: z.string(),
  scheduleKind: z.string().nullable().optional(),
  intervalSec: z.number().int().nullable().optional(),
  calendarHour: z.number().int().nullable().optional(),
  calendarMinute: z.number().int().nullable().optional(),
  runAtLoad: z.boolean().optional(),
  keepAlive: z.boolean().optional(),
  running: z.boolean().nullable().optional(),
  logPath: z.string().nullable().optional(),
  lastFire: z.string().datetime().nullable().optional(),
  programArgs: z.array(z.string()).optional(),
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

const TaskResultInput = z.object({
  id: z.string(),
  status: z.string(),
  output: z.string().optional(),
  durationMs: z.number().int().optional(),
  happySessionId: z.string().nullable().optional(),
  lastFire: z.string().datetime().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  // Fallback handler — actual routes are co-located in /api/sync/<thing>/route.ts
  return NextResponse.json({ error: 'use /api/sync/<thing>' }, { status: 404 });
}

export { resolveMachine, AgentInput, LaunchAgentInput, UsageInput, TaskResultInput };
