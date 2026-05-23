import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LAUNCH_AGENTS_DIR } from '../config';

function sh(cmd: string): string {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 2000 });
  return (r.stdout ?? '').trim();
}

function plistGet(p: string, key: string): string | null {
  return sh(`/usr/libexec/PlistBuddy -c ${JSON.stringify('Print :' + key)} ${JSON.stringify(p)} 2>/dev/null`) || null;
}
function plistProgramArgs(p: string): string[] {
  const out = sh(
    `/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' ${JSON.stringify(p)} 2>/dev/null | sed -n 's/^ *//p' | tail -n +2 | sed '$d'`,
  );
  return out.split('\n').filter(Boolean);
}
function plistCalendar(p: string): { Hour?: number; Minute?: number; Day?: number } | null {
  const out = sh(`/usr/libexec/PlistBuddy -c 'Print :StartCalendarInterval' ${JSON.stringify(p)} 2>/dev/null`);
  if (!out) return null;
  const get = (k: string) => {
    const m = out.match(new RegExp(`${k} = (\\d+)`));
    return m ? Number(m[1]) : undefined;
  };
  return { Hour: get('Hour'), Minute: get('Minute'), Day: get('Day') };
}

export type LaunchAgentRow = {
  label: string;
  scheduleKind: string | null;
  intervalSec: number | null;
  calendarHour: number | null;
  calendarMinute: number | null;
  runAtLoad: boolean;
  keepAlive: boolean;
  running: boolean | null;
  logPath: string | null;
  lastFire: string | null;
  programArgs: string[];
};

export function collectLaunchAgents(): LaunchAgentRow[] {
  const out: LaunchAgentRow[] = [];
  for (const f of fs.readdirSync(LAUNCH_AGENTS_DIR)) {
    if (!/^ai\.(claudeclaw|openclaw)\..+\.plist$/.test(f)) continue;
    if (f.includes('.bak')) continue;
    const p = path.join(LAUNCH_AGENTS_DIR, f);
    const label = f.replace(/\.plist$/, '');
    const programArgs = plistProgramArgs(p);
    const interval = plistGet(p, 'StartInterval');
    const cal = plistCalendar(p);
    const runAtLoad = plistGet(p, 'RunAtLoad') === 'true';
    const keepAlive = plistGet(p, 'KeepAlive');
    const stdoutPath = plistGet(p, 'StandardOutPath');
    const stderrPath = plistGet(p, 'StandardErrorPath');

    let scheduleKind: string | null = null;
    if (interval) scheduleKind = `every ${interval}s`;
    else if (cal) scheduleKind = `daily @ ${cal.Hour ?? '?'}:${String(cal.Minute ?? 0).padStart(2, '0')}`;
    else if (runAtLoad) scheduleKind = 'RunAtLoad';
    else if (keepAlive) scheduleKind = 'KeepAlive';

    const logPath = stdoutPath || stderrPath || null;
    let lastFire: string | null = null;
    if (logPath) {
      try {
        const st = fs.statSync(logPath);
        lastFire = new Date(st.mtimeMs).toISOString();
      } catch {}
    }

    let running: boolean | null = null;
    if (keepAlive === 'true') {
      const exe = (programArgs[0] || '').split('/').pop();
      if (exe) {
        running = !!sh(`pgrep -f ${JSON.stringify(exe)} | head -1`);
      }
    }

    out.push({
      label,
      scheduleKind,
      intervalSec: interval ? Number(interval) : null,
      calendarHour: cal?.Hour ?? null,
      calendarMinute: cal?.Minute ?? null,
      runAtLoad,
      keepAlive: keepAlive === 'true',
      running,
      logPath,
      lastFire,
      programArgs,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
