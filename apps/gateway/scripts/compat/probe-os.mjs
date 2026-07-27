#!/usr/bin/env node
// probe-os.mjs — runs the EXACT OS commands the hermit-ui gateway issues and
// reports pass/fail + whether the gateway's parser would actually get data.
// No repo deps, so it runs identically on macOS and Linux.
//
// Usage: node probe-os.mjs

import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const results = [];
function rec(id, area, cmd, verdict, note) {
  results.push({ id, area, cmd, verdict, note });
  const tag = verdict === 'OK' ? 'OK  ' : verdict === 'ABSENT' ? 'ABS ' : verdict === 'DEGRADED' ? 'DEG ' : 'FAIL';
  console.log(`[${tag}] ${id.padEnd(22)} ${cmd}${note ? `\n         → ${note}` : ''}`);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 8000, ...opts });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '').trim(),
    err: r.error ? r.error.code || r.error.message : null,
  };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-probe-'));
console.log(`\n=== hermit-ui gateway OS compatibility probe ===`);
console.log(`platform: ${process.platform} ${os.release()} (${process.arch})  node ${process.version}`);
console.log(`tmpdir:   ${TMP}\n`);

// ─── A. process / host probes ────────────────────────────────────────────────
// host-stat.ts:83 chromeCensus
{
  const r = sh('ps', ['-Axo', 'rss,command']);
  const lines = r.stdout.split('\n').filter((l) => /^\s*\d+\s+\S/.test(l));
  rec('host-stat/chromeCensus', 'ps', 'ps -Axo rss,command',
    r.err ? 'FAIL' : r.status !== 0 ? 'FAIL' : lines.length > 5 ? 'OK' : 'DEGRADED',
    r.err ? `spawn error ${r.err}` : r.status !== 0 ? `exit ${r.status}: ${r.stderr.slice(0, 200)}` : `${lines.length} parseable rows`);
}
// session-snapshot.ts:69 collectPsTree
{
  const r = sh('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = r.stdout.split('\n').filter((l) => /^\s*\d+\s+\d+\s+\d+\s*$/.test(l.trim()));
  rec('snapshot/collectPsTree', 'ps', 'ps -axo pid=,ppid=,rss=',
    r.err || r.status !== 0 ? 'FAIL' : rows.length > 5 ? 'OK' : 'DEGRADED',
    r.err ? `spawn error ${r.err}` : r.status !== 0 ? `exit ${r.status}: ${r.stderr.slice(0, 200)}` : `${rows.length} parseable rows`);
}
// tmux-driver.ts:89 paneClaudeSessionId
{
  const r = sh('ps', ['-ww', '-o', 'command=', '-p', String(process.pid)]);
  rec('driver/paneArgvRead', 'ps', 'ps -ww -o command= -p <pid>',
    r.status === 0 && /node/.test(r.stdout) ? 'OK' : 'FAIL',
    r.status !== 0 ? `exit ${r.status}: ${r.stderr.slice(0, 120)}` : `argv len ${r.stdout.trim().length}`);
}
// host-stat.ts macStat
{
  const r1 = sh('sysctl', ['-n', 'vm.swapusage']);
  rec('host-stat/macSwap', 'host', 'sysctl -n vm.swapusage',
    r1.status === 0 && /total =/.test(r1.stdout) ? 'OK' : 'ABSENT',
    r1.err ? `spawn error ${r1.err} (expected off-macOS)` : r1.status !== 0 ? `exit ${r1.status}` : r1.stdout.trim().slice(0, 80));
  const r2 = sh('vm_stat', []);
  rec('host-stat/macRamFree', 'host', 'vm_stat',
    r2.status === 0 && /page size of/.test(r2.stdout) ? 'OK' : 'ABSENT',
    r2.err ? `spawn error ${r2.err} (expected off-macOS)` : `exit ${r2.status}`);
}
// host-stat.ts linuxStat
{
  const r = sh('cat', ['/proc/meminfo']);
  const has = /^MemAvailable:\s+\d+ kB/m.test(r.stdout);
  rec('host-stat/linuxRam', 'host', 'cat /proc/meminfo',
    r.status === 0 && has ? 'OK' : 'ABSENT',
    r.status === 0 ? (has ? `MemAvailable parsed` : 'no MemAvailable key') : `exit ${r.status} (expected off-Linux)`);
}
// config.ts keychainKey — must degrade, not throw
{
  let threw = null;
  let r = null;
  try {
    r = sh('security', ['find-generic-password', '-a', 'asst', '-s', 'asst-gateway-vps-key', '-w']);
  } catch (e) { threw = e.message; }
  rec('config/keychainFallback', 'host', 'security find-generic-password …',
    threw ? 'FAIL' : r.status === 0 ? 'OK' : 'ABSENT',
    threw ? `THREW: ${threw}` : r.err ? `spawn error ${r.err} → spawnSync returns error (no throw), ASST_KEY falls back to .env — safe` : `exit ${r.status}`);
}
// node:os portable baseline
{
  const freeMb = Math.round(os.freemem() / 1048576);
  const totalMb = Math.round(os.totalmem() / 1048576);
  rec('host-stat/nodeOsBase', 'host', 'os.freemem/totalmem/loadavg/cpus',
    totalMb > 0 && os.cpus().length > 0 ? 'OK' : 'FAIL',
    `total ${totalMb}MB free ${freeMb}MB load1 ${os.loadavg()[0].toFixed(2)} cpus ${os.cpus().length}`);
}
// chrome census regex vs this host's real chrome process names
{
  const r = sh('ps', ['-Axo', 'rss,command']);
  const hits = r.stdout.split('\n').filter((l) => /Google Chrome|chrom(e|ium)/i.test(l));
  const mains = hits.filter((l) => l.includes('--remote-debugging-port') && !l.includes('--type='));
  rec('host-stat/chromeRegex', 'host', '/Google Chrome|chrom(e|ium)/i over ps output',
    'OK', `${hits.length} chrome-ish rows, ${mains.length} main(CDP) — informational`);
}

// ─── B. tail ────────────────────────────────────────────────────────────────
const jsonl = path.join(TMP, 'probe.jsonl');
fs.writeFileSync(jsonl, Array.from({ length: 20 }, (_, i) => JSON.stringify({ n: i })).join('\n') + '\n');
{
  const r = sh('tail', ['-n', '5', jsonl]);
  rec('snapshot/tailLines', 'tail', 'tail -n 5 <jsonl>',
    r.status === 0 && r.stdout.trim().split('\n').length === 5 ? 'OK' : 'FAIL', `exit ${r.status}`);
  const r2 = sh('tail', ['-c', String(8 * 1024 * 1024), jsonl]);
  rec('snapshot/tailBytes', 'tail', 'tail -c 8388608 <jsonl>',
    r2.status === 0 && r2.stdout.includes('"n":19') ? 'OK' : 'FAIL', `exit ${r2.status}`);
}
// watchTranscript: tail -n +1 -F must stream history AND live appends
const tailFollow = await new Promise((resolve) => {
  const child = spawn('tail', ['-n', '+1', '-F', jsonl], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); });
  child.on('error', () => resolve({ ok: false, note: 'spawn error' }));
  setTimeout(() => {
    fs.appendFileSync(jsonl, JSON.stringify({ live: true }) + '\n');
    setTimeout(() => {
      child.kill('SIGTERM');
      const gotHistory = buf.includes('"n":0');
      const gotLive = buf.includes('"live":true');
      resolve({ ok: gotHistory && gotLive, note: `history=${gotHistory} liveAppend=${gotLive}` });
    }, 900);
  }, 500);
});
rec('driver/watchTranscript', 'tail', 'tail -n +1 -F <jsonl> (stream)', tailFollow.ok ? 'OK' : 'FAIL', tailFollow.note);

// ─── C. tmux ────────────────────────────────────────────────────────────────
const tv = sh('tmux', ['-V']);
rec('tmux/version', 'tmux', 'tmux -V', tv.status === 0 ? 'OK' : 'FAIL', tv.stdout.trim() || tv.err || `exit ${tv.status}`);

const PANE = `hermitprobe-${process.pid}`;
if (tv.status === 0) {
  const paneCwd = path.join(TMP, 'cwd');
  fs.mkdirSync(paneCwd, { recursive: true });
  // The gateway launches: new-session -d -s N -c CWD -x 200 -y 50 -e K=V '<cmd>'
  // Command below echoes the injected env into a file so we can prove `-e` works.
  const marker = path.join(TMP, 'env-marker.txt');
  const cmd = `sh -c 'printf "%s" "$HERMIT_PROBE_VAR" > ${marker}; sleep 60'`;
  const ns = sh('tmux', ['new-session', '-d', '-s', PANE, '-c', paneCwd, '-x', '200', '-y', '50',
    '-e', 'HERMIT_PROBE_VAR=injected-ok', cmd]);
  rec('driver/ensureSession', 'tmux', "new-session -d -s N -c CWD -x 200 -y 50 -e K=V '<cmd>'",
    ns.status === 0 ? 'OK' : 'FAIL', ns.status !== 0 ? ns.stderr.slice(0, 200) : 'created');

  if (ns.status === 0) {
    await new Promise((r) => setTimeout(r, 700));
    const envOk = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === 'injected-ok';
    rec('driver/paneEnvInject', 'tmux', 'new-session -e K=V → child env',
      envOk ? 'OK' : 'FAIL', envOk ? 'pane child saw HERMIT_PROBE_VAR' : 'env NOT visible to pane child');

    const hs = sh('tmux', ['has-session', '-t', `=${PANE}`]);
    rec('driver/hasSession', 'tmux', 'has-session -t =NAME', hs.status === 0 ? 'OK' : 'FAIL', `exit ${hs.status}`);

    const dm = sh('tmux', ['display-message', '-p', '-t', `${PANE}.0`, '#{pane_pid}']);
    const dmPid = Number(dm.stdout.trim());
    rec('driver/panePidLookup', 'tmux', "display-message -p -t NAME.0 '#{pane_pid}'",
      dm.status === 0 && Number.isInteger(dmPid) && dmPid > 0 ? 'OK' : 'FAIL', `pid=${dm.stdout.trim() || '(empty)'}`);

    // The known macOS gotcha: `=NAME` form returns empty with exit 0.
    const dmEq = sh('tmux', ['display-message', '-p', '-t', `=${PANE}`, '#{pane_pid}']);
    rec('driver/panePidEqForm', 'tmux', "display-message -p -t =NAME '#{pane_pid}'",
      'OK', `exit ${dmEq.status} out='${dmEq.stdout.trim()}' (informational: driver uses NAME.0 because of this)`);

    const lp = sh('tmux', ['list-panes', '-t', `=${PANE}`, '-F', '#{pane_pid}']);
    rec('snapshot/listPanes', 'tmux', "list-panes -t =NAME -F '#{pane_pid}'",
      lp.status === 0 && Number(lp.stdout.trim()) > 0 ? 'OK' : 'FAIL', `pid=${lp.stdout.trim()}`);

    const cp = sh('tmux', ['capture-pane', '-t', `${PANE}.0`, '-p']);
    rec('pane/capturePane', 'tmux', 'capture-pane -t NAME.0 -p', cp.status === 0 ? 'OK' : 'FAIL', `exit ${cp.status}, ${cp.stdout.split('\n').length} rows`);

    const cps = sh('tmux', ['capture-pane', '-t', PANE, '-p', '-S', '-90']);
    rec('planUsage/captureScrollback', 'tmux', 'capture-pane -t NAME -p -S -90', cps.status === 0 ? 'OK' : 'FAIL', `exit ${cps.status}`);

    const sk1 = sh('tmux', ['send-keys', '-t', `${PANE}.0`, '-l', '--', '- literal dash line']);
    rec('driver/sendKeysLiteral', 'tmux', "send-keys -t NAME.0 -l -- '- text'", sk1.status === 0 ? 'OK' : 'FAIL', sk1.stderr.slice(0, 160) || `exit ${sk1.status}`);
    const sk2 = sh('tmux', ['send-keys', '-t', `${PANE}.0`, 'M-Enter']);
    rec('driver/sendKeysMetaEnter', 'tmux', 'send-keys -t NAME.0 M-Enter', sk2.status === 0 ? 'OK' : 'FAIL', sk2.stderr.slice(0, 160) || `exit ${sk2.status}`);
    const sk3 = sh('tmux', ['send-keys', '-t', `${PANE}.0`, 'Enter']);
    rec('driver/sendKeysEnter', 'tmux', 'send-keys -t NAME.0 Enter', sk3.status === 0 ? 'OK' : 'FAIL', `exit ${sk3.status}`);
    const sk4 = sh('tmux', ['send-keys', '-t', `${PANE}.0`, 'Escape']);
    rec('driver/sendInterrupt', 'tmux', 'send-keys -t NAME.0 Escape', sk4.status === 0 ? 'OK' : 'FAIL', `exit ${sk4.status}`);

    const so = sh('tmux', ['set-option', '-t', PANE, 'mouse', 'on']);
    rec('control/setMouseOn', 'tmux', 'set-option -t NAME mouse on', so.status === 0 ? 'OK' : 'FAIL', so.stderr.slice(0, 160) || `exit ${so.status}`);

    const ls = sh('tmux', ['list-sessions', '-F', '#{session_name}']);
    rec('driver/listSessions', 'tmux', "list-sessions -F '#{session_name}'",
      ls.status === 0 && ls.stdout.includes(PANE) ? 'OK' : 'FAIL', `${ls.stdout.split('\n').filter(Boolean).length} sessions`);

    const kill = sh('tmux', ['kill-session', '-t', PANE]);
    rec('driver/killSession', 'tmux', 'kill-session -t NAME', kill.status === 0 ? 'OK' : 'FAIL', `exit ${kill.status}`);
  }
}

// ─── D. archive tools (file-manager download / file-station upload) ─────────
{
  const src = path.join(TMP, 'zipme');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
  const zipPath = path.join(TMP, 'out.zip');
  const z = sh('zip', ['-r', '-q', zipPath, 'zipme'], { cwd: TMP });
  rec('fileManager/zipFolder', 'archive', 'zip -r -q out.zip <dir>',
    z.err ? 'ABSENT' : z.status === 0 && fs.existsSync(zipPath) ? 'OK' : 'FAIL',
    z.err ? `spawn error ${z.err} — folder download would break` : `exit ${z.status}`);
  const outDir = path.join(TMP, 'unz');
  const u = sh('unzip', ['-o', zipPath, '-d', outDir]);
  rec('fileStation/unzip', 'archive', 'unzip -o <zip> -d <dir>',
    u.err ? 'ABSENT' : u.status === 0 && fs.existsSync(path.join(outDir, 'zipme', 'a.txt')) ? 'OK' : 'FAIL',
    u.err ? `spawn error ${u.err} — zip upload extract would break` : `exit ${u.status}`);
}

// ─── E. node-pty (browser terminal) ────────────────────────────────────────
{
  let note = '', verdict = 'FAIL';
  try {
    // Resolve from the repo's own node_modules (this script lives outside it).
    const { createRequire } = await import('node:module');
    // <repo>/apps/gateway/scripts/compat/probe-os.mjs → repo root is 4 levels up.
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repo = process.env.HERMIT_REPO ?? path.resolve(here, '..', '..', '..', '..');
    const req = createRequire(path.join(repo, 'apps', 'gateway', 'package.json'));
    const pty = req('@homebridge/node-pty-prebuilt-multiarch');
    const child = pty.spawn('sh', ['-c', 'echo pty-alive'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: TMP, env: { ...process.env, TERM: 'xterm-256color' },
    });
    const out = await new Promise((resolve) => {
      let b = '';
      child.onData((d) => { b += d; });
      child.onExit(() => resolve(b));
      setTimeout(() => resolve(b), 3000);
    });
    verdict = /pty-alive/.test(out) ? 'OK' : 'DEGRADED';
    note = `loaded + spawned, output=${JSON.stringify(out.trim().slice(0, 40))}`;
  } catch (e) {
    note = `import/spawn failed: ${String(e.message).slice(0, 200)}`;
  }
  rec('control/nodePty', 'pty', "pty.spawn (node-pty-prebuilt-multiarch)", verdict, note);
}

// ─── F. misc helpers ───────────────────────────────────────────────────────
{
  const b = sh('bash', ['-lc', 'echo login-shell-ok']);
  rec('machineReq/bashLoginShell', 'misc', "bash -lc '…'", b.status === 0 && /login-shell-ok/.test(b.stdout) ? 'OK' : 'FAIL', `exit ${b.status}`);
  const uu = sh('uuidgen', []);
  rec('test/uuidgen', 'misc', 'uuidgen (fake-claude.sh)', uu.err ? 'ABSENT' : uu.status === 0 ? 'OK' : 'FAIL', uu.err ? `spawn error ${uu.err}` : uu.stdout.trim().slice(0, 40));
  const cl = sh('sh', ['-c', 'command -v claude || true']);
  rec('gateway/claudeBin', 'misc', 'command -v claude', cl.stdout.trim() ? 'OK' : 'ABSENT', cl.stdout.trim() || 'claude NOT on PATH');
  const homeClaude = path.join(os.homedir(), '.local', 'bin', 'claude');
  rec('planUsage/claudeAtHomeLocalBin', 'misc', '~/.local/bin/claude (hardcoded in plan-usage)',
    fs.existsSync(homeClaude) ? 'OK' : 'ABSENT', homeClaude);
  const secretBin = path.join(os.homedir(), '.local', 'bin', 'secret');
  rec('secrets/secretCli', 'misc', '~/.local/bin/secret', fs.existsSync(secretBin) ? 'OK' : 'ABSENT', secretBin);
  const projRoot = path.join(os.homedir(), '.claude', 'projects');
  rec('driver/projectsDir', 'misc', '~/.claude/projects', fs.existsSync(projRoot) ? 'OK' : 'ABSENT', projRoot);
}

// ─── summary ───────────────────────────────────────────────────────────────
const counts = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
console.log(`\n=== SUMMARY (${process.platform}) ===`);
console.log(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  '));
const bad = results.filter((r) => r.verdict === 'FAIL');
if (bad.length) {
  console.log(`\nFAILURES:`);
  for (const b of bad) console.log(`  - ${b.id}: ${b.cmd}  (${b.note})`);
}
fs.writeFileSync(path.join(TMP, 'results.json'), JSON.stringify({ platform: process.platform, release: os.release(), results }, null, 2));
console.log(`\nJSON: ${path.join(TMP, 'results.json')}`);
try { fs.rmSync(path.join(TMP, 'zipme'), { recursive: true, force: true }); } catch {}
