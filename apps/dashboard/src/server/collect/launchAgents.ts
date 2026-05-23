// LaunchAgent snapshot — globs ~/Library/LaunchAgents/ai.{claudeclaw,openclaw}.*.plist,
// extracts schedule + log path, infers last-fire mtime.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prisma } from '../db';

const LAUNCH_AGENTS_DIR = '/Users/mac/Library/LaunchAgents';

function sh(cmd: string, timeoutMs = 1500) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  return (r.stdout ?? '').trim();
}

function plistGet(p: string, key: string) {
  return sh(`/usr/libexec/PlistBuddy -c ${JSON.stringify('Print :' + key)} ${JSON.stringify(p)} 2>/dev/null`);
}

function plistProgramArgs(p: string): string[] {
  const out = sh(
    `/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' ${JSON.stringify(p)} 2>/dev/null`,
  );
  const lines = out.split('\n').map((s) => s.trim());
  // Output is "Array {" header then items, then "}". Strip wrappers.
  return lines.filter((l) => l && l !== 'Array {' && l !== '}' && !l.endsWith('= {'));
}

export async function collectLaunchAgents(machineId: string) {
  const entries = (await fsp.readdir(LAUNCH_AGENTS_DIR)).filter(
    (f) => /^ai\.(claudeclaw|openclaw)\..+\.plist$/.test(f) && !f.includes('.bak'),
  );

  const labels: string[] = [];

  for (const f of entries) {
    const p = path.join(LAUNCH_AGENTS_DIR, f);
    const label = f.replace(/\.plist$/, '');
    labels.push(label);

    const programArgs = plistProgramArgs(p);
    const intervalStr = plistGet(p, 'StartInterval');
    const intervalSec = intervalStr && /^\d+$/.test(intervalStr) ? Number(intervalStr) : null;

    const calOut = sh(
      `/usr/libexec/PlistBuddy -c 'Print :StartCalendarInterval' ${JSON.stringify(p)} 2>/dev/null`,
    );
    let calendarHour: number | null = null;
    let calendarMinute: number | null = null;
    if (calOut) {
      const hMatch = calOut.match(/Hour\s*=\s*(\d+)/);
      const mMatch = calOut.match(/Minute\s*=\s*(\d+)/);
      if (hMatch) calendarHour = Number(hMatch[1]);
      if (mMatch) calendarMinute = Number(mMatch[1]);
    }

    const runAtLoad = plistGet(p, 'RunAtLoad') === 'true';
    const keepAlive = plistGet(p, 'KeepAlive') === 'true';
    const stdoutPath = plistGet(p, 'StandardOutPath') || null;
    const stderrPath = plistGet(p, 'StandardErrorPath') || null;
    const logPath = stdoutPath || stderrPath;

    let scheduleKind: string | null = null;
    if (intervalSec) scheduleKind = `every ${intervalSec}s`;
    else if (calendarHour !== null) {
      const mm = String(calendarMinute ?? 0).padStart(2, '0');
      scheduleKind = `daily @ ${calendarHour}:${mm}`;
    } else if (runAtLoad) scheduleKind = 'RunAtLoad';
    else if (keepAlive) scheduleKind = 'KeepAlive';

    let lastFire: Date | null = null;
    if (logPath) {
      try {
        const st = fs.statSync(logPath);
        lastFire = new Date(st.mtimeMs);
      } catch {}
    }

    let running: boolean | null = null;
    if (keepAlive) {
      const exe = (programArgs[0] ?? '').split('/').pop();
      if (exe) running = sh(`pgrep -f ${JSON.stringify(exe)} | head -1`) !== '';
    }

    await prisma.launchAgentRecord.upsert({
      where: { machineId_label: { machineId, label } },
      create: {
        machineId,
        label,
        scheduleKind,
        intervalSec,
        calendarHour,
        calendarMinute,
        runAtLoad,
        keepAlive,
        running,
        logPath,
        lastFire,
        programArgs,
      },
      update: {
        scheduleKind,
        intervalSec,
        calendarHour,
        calendarMinute,
        runAtLoad,
        keepAlive,
        running,
        logPath,
        lastFire,
        programArgs,
      },
    });
  }

  await prisma.launchAgentRecord.deleteMany({
    where: { machineId, NOT: { label: { in: labels } } },
  });

  return labels.length;
}
