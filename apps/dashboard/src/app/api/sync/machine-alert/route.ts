// POST /api/sync/machine-alert — a machine reports a health alert about itself.
//
// Writers: the on-host gateway watchdog (scripts/gateway-watch.sh — gateway
// wedged / high load / resurrected) and gateway ticks that had to act
// (stray-reaper killing leaked browsers). All reports are episodic: they carry
// a TTL and lapse on their own when the reporter goes quiet, so this route
// never has to know how to resolve them. The one condition alert with an owner
// (stuck-messages) is raised and resolved by server/machine-alerts.ts directly,
// not through here.
//
// Dedup lives in openAlert: one open row per (machine, kind), re-push at most
// every 30 min — so a watchdog re-reporting hourly while a condition holds is
// one banner + one push, not a stack.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveMachine } from '../route';
import { openAlert } from '@/server/machine-alerts';

// Whitelist, so a typo'd kind in a hand-rolled caller shows up as a 400 here
// instead of a junk row nobody's UI knows how to word.
const KINDS = [
  'gateway-wedged',
  'high-load',
  'chrome-leak',
  'gateway-resurrected',
  'gateway-start-failed',
] as const;

const Body = z.object({
  kind: z.enum(KINDS),
  message: z.string().min(1).max(500),
  count: z.number().int().min(1).max(100_000).optional(),
  // Where tapping the banner / push lands; watchdog reports default to /watchdogs.
  linkPath: z.string().max(200).optional(),
  // How long the alert may live without being re-reported. The watchdog runs
  // hourly, so its kinds default to just over two runs; a 5-minute gateway tick
  // should pass something short (chrome-leak passes 30m).
  ttlMinutes: z.number().int().min(5).max(24 * 60).optional(),
});

const DEFAULT_TTL_MINUTES = 130;

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  await openAlert({
    machineId: machine.id,
    machineName: machine.alias?.trim() || machine.name,
    kind: body.kind,
    message: body.message,
    count: body.count ?? 1,
    ttlMs: (body.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000,
    linkPath: body.linkPath ?? '/watchdogs',
  });
  return NextResponse.json({ ok: true });
}
