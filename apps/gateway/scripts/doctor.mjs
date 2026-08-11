#!/usr/bin/env node
// `npm run doctor` — is this machine ready to host agents?
//
// Written for the first ten minutes on a new node, which is where the cost of
// a wrong assumption is highest and the person running it knows the least. The
// rule throughout: never say "warning: something may be missing". Say which
// package, and give the command that installs it.
//
// Cross-platform by construction — it is the one place that is ALLOWED to know
// about apt, because telling a Linux user to `brew install` is exactly the kind
// of unhelpful help this replaces.
//
// Exit code is 1 if any REQUIRED check failed, so it can gate a deploy.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isDarwin = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

const C = process.stdout.isTTY
  ? { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' }
  : { ok: '', warn: '', bad: '', dim: '', off: '' };

let failed = 0;
let warned = 0;

/** @param {'ok'|'warn'|'bad'} level */
function line(level, label, detail, fix) {
  const mark = level === 'ok' ? '✔' : level === 'warn' ? '!' : '✘';
  const colour = level === 'ok' ? C.ok : level === 'warn' ? C.warn : C.bad;
  console.log(`${colour}${mark}${C.off} ${label}${detail ? `  ${C.dim}${detail}${C.off}` : ''}`);
  if (fix) console.log(`    ${C.dim}→ ${fix}${C.off}`);
  if (level === 'bad') failed += 1;
  if (level === 'warn') warned += 1;
}

function section(title) {
  console.log(`\n${title}`);
}

/** Install hint for the platform in front of us. */
function install(aptPkg, brewPkg) {
  if (isLinux) return `sudo apt install -y ${aptPkg}`;
  if (isDarwin) return `brew install ${brewPkg ?? aptPkg}`;
  return `install ${aptPkg}`;
}

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'command', ['-v', bin], {
    encoding: 'utf8',
    shell: true,
  });
  const out = (r.stdout ?? '').trim().split('\n')[0];
  return r.status === 0 && out ? out : null;
}

function capture(bin, args, timeout = 8000) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** A binary that must exist for a core feature to work. */
function needBin(bin, what, aptPkg, brewPkg) {
  const at = which(bin);
  if (at) line('ok', bin, at);
  else line('bad', bin, `missing — ${what}`, install(aptPkg ?? bin, brewPkg));
  return at;
}

/** A binary whose absence degrades something but does not stop the gateway. */
function wantBin(bin, what, aptPkg, brewPkg) {
  const at = which(bin);
  if (at) line('ok', bin, at);
  else line('warn', bin, `missing — ${what}`, install(aptPkg ?? bin, brewPkg));
  return at;
}

console.log(`hermit-ui gateway doctor — ${process.platform} ${os.arch()} · node ${process.version}`);

// ── the things chat cannot run without ───────────────────────────────────────
section('core');

const tmuxBin = needBin('tmux', 'chat runs claude in a tmux pane', 'tmux');
if (tmuxBin) {
  const v = capture('tmux', ['-V']) ?? '';
  const num = Number.parseFloat((v.match(/(\d+\.\d+)/) ?? [])[1] ?? '0');
  // `new-session -e KEY=VAL` is 3.2+. Below that the env silently does not
  // reach the pane, so the permission hook never receives the dashboard key —
  // a failure that looks like the agent ignoring web-permission requests
  // rather than like an old tmux. Debian 11 ships 3.1c and is NOT enough.
  if (num >= 3.2) line('ok', 'tmux ≥ 3.2', v);
  else line('bad', 'tmux ≥ 3.2', `${v} — new-session -e is 3.2+; pane env is dropped silently`,
    isLinux ? 'use Ubuntu 22.04+ (3.2a) or build tmux from source' : 'brew upgrade tmux');
}

// The BSD/procps split that made the Chrome census silently null on Linux.
const psOk = spawnSync('ps', ['-axo', 'rss,command'], { encoding: 'utf8', timeout: 5000 });
if (psOk.status === 0 && (psOk.stdout ?? '').split('\n').length > 5) {
  line('ok', 'ps -axo', `${(psOk.stdout ?? '').split('\n').length} rows`);
} else {
  line('bad', 'ps -axo', `exit ${psOk.status} ${(psOk.stderr ?? '').trim()}`, 'install procps');
}

const node = Number.parseInt(process.versions.node.split('.')[0], 10);
if (node >= 20) line('ok', 'node ≥ 20', process.version);
else line('bad', 'node ≥ 20', process.version, 'install Node 20 or newer');

// ── the agent backends ───────────────────────────────────────────────────────
section('backends');

// claude: resolved the same way the gateway resolves it, so what this prints is
// what the gateway will actually run.
const claudeCandidates = [
  process.env.HERMIT_CLAUDE_BIN?.trim(),
  ...(process.env.PATH ?? '').split(':').map((d) => d && path.join(d, 'claude')),
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  ...(isDarwin ? ['/opt/homebrew/bin/claude'] : [path.join(os.homedir(), '.npm-global', 'bin', 'claude'), '/snap/bin/claude']),
].filter(Boolean);
const claudeAt = claudeCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (claudeAt) {
  line('ok', 'claude', `${claudeAt}${capture(claudeAt, ['--version']) ? ` (${capture(claudeAt, ['--version'])})` : ''}`);
} else {
  line('bad', 'claude', 'not found — the claude-tmux backend cannot start a session',
    'install Claude Code, then set HERMIT_CLAUDE_BIN if it lands somewhere unusual');
}

// codex: optional. Only sessions on the codex-exec backend need it.
const codexAt = process.env.HERMIT_CODEX_BIN?.trim() || which('codex');
if (codexAt) {
  line('ok', 'codex', `${codexAt}${capture('codex', ['--version']) ? ` (${capture('codex', ['--version'])})` : ''}`);
  // Auth is per machine and does NOT propagate: a node that has the binary but
  // no login fails at the first turn with an error the chat shows as a system
  // row. Better to say so here.
  const authFile = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'auth.json');
  if (fs.existsSync(authFile)) line('ok', 'codex login', authFile);
  else line('warn', 'codex login', 'no auth.json — codex sessions will fail at the first turn', 'codex login');
} else {
  line('warn', 'codex', 'not found — the codex-exec backend is unavailable on this machine',
    'npm i -g @openai/codex   (only needed if you want the Codex backend)');
}

// ── files and directories ────────────────────────────────────────────────────
section('workspace');

const envFile = path.join(GATEWAY_DIR, '.env');
if (!fs.existsSync(envFile)) {
  line('bad', '.env', `${envFile} missing`, `cp ${path.join(GATEWAY_DIR, '.env.example')} ${envFile} && $EDITOR ${envFile}`);
} else {
  line('ok', '.env', envFile);
  // Parsed rather than imported: importing config.ts would exit(1) on a missing
  // key, and a doctor that dies on the first problem cannot report the rest.
  const env = Object.fromEntries(
    fs.readFileSync(envFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );

  const agentsRoot = env.AGENTS_ROOT || process.env.AGENTS_ROOT;
  if (!agentsRoot) {
    line('bad', 'AGENTS_ROOT', 'not set — the gateway refuses to start', `add AGENTS_ROOT=/path/to/agents to ${envFile}`);
  } else if (!fs.existsSync(agentsRoot)) {
    line('bad', 'AGENTS_ROOT', `${agentsRoot} does not exist`, `mkdir -p ${agentsRoot}`);
  } else {
    const agents = fs.readdirSync(agentsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    line('ok', 'AGENTS_ROOT', `${agentsRoot} (${agents.length} ${agents.length === 1 ? 'agent' : 'agents'})`);

    // ext4 is case-sensitive and APFS is not. An agent whose file is
    // `Claude.md` works on a Mac and is INVISIBLE to the collectors on Linux —
    // collect/agents.ts reads the exact name and returns null. This is the
    // single most likely way a migrated agent silently disappears.
    if (isLinux) {
      const wrong = [];
      for (const a of agents) {
        for (const want of ['CLAUDE.md', 'AGENTS.md', 'IDENTITY.md']) {
          const dir = path.join(agentsRoot, a.name);
          let names;
          try { names = fs.readdirSync(dir); } catch { continue; }
          const hit = names.find((n) => n.toLowerCase() === want.toLowerCase());
          if (hit && hit !== want) wrong.push(`${a.name}/${hit} should be ${want}`);
        }
      }
      if (wrong.length === 0) line('ok', 'agent filename case', 'all as expected');
      else line('bad', 'agent filename case', wrong.join('; '), 'rename them — ext4 is case-sensitive and the collectors read the exact name');
    }
  }

  if (!(env.ASST_KEY || env.HERMIT_KEY || process.env.ASST_KEY)) {
    line('bad', 'ASST_KEY', 'not set — the gateway refuses to start', `add ASST_KEY=… to ${envFile}`);
  } else {
    line('ok', 'ASST_KEY', 'set');
  }

  const dash = env.DASHBOARD_URL || process.env.DASHBOARD_URL;
  if (!dash) line('warn', 'DASHBOARD_URL', 'not set — defaults to http://127.0.0.1:4101');
  else line('ok', 'DASHBOARD_URL', dash);
}

const projects = process.env.PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects');
if (fs.existsSync(projects)) {
  try {
    fs.accessSync(projects, fs.constants.W_OK);
    line('ok', 'PROJECTS_ROOT', projects);
  } catch {
    line('bad', 'PROJECTS_ROOT', `${projects} is not writable`, `chown -R $USER ${projects}`);
  }
} else {
  // Created by claude on first run, so absence is normal on a fresh box.
  line('warn', 'PROJECTS_ROOT', `${projects} does not exist yet (claude creates it on first run)`);
}

// ── everything the agent template shells out to ──────────────────────────────
section('agent capabilities');

wantBin('zip', 'downloading a folder from the dashboard', 'zip');
wantBin('unzip', 'uploading an archive to an agent', 'unzip');

// Image handling. The template's HARD RULE is that an agent must refuse to read
// an oversized image, so "no backend at all" must be loud: with none of these
// the pre-read hook cannot measure anything.
const sips = isDarwin ? which('sips') : null;
const magick = which('magick') ?? which('convert');
const identify = which('identify');
const pillow = spawnSync('python3', ['-c', 'import PIL, sys; sys.stdout.write(PIL.__version__)'], {
  encoding: 'utf8', timeout: 8000,
});
const hasPillow = pillow.status === 0;
if (sips) line('ok', 'image backend', `sips (${sips})`);
else if (magick && identify) line('ok', 'image backend', `ImageMagick (${magick})`);
else if (hasPillow) line('ok', 'image backend', `python3 PIL ${(pillow.stdout ?? '').trim()}`);
else line('bad', 'image backend', 'none — agents cannot size or downscale images, so every image read is refused',
  install('imagemagick'));

// jq is /usr/bin/jq on macOS and absent on a default Ubuntu. The template's
// scripts fall back to node, so this is a warning rather than a failure — but
// node must then be on the PATH of the SHELL the hooks run in, not just here.
if (which('jq')) line('ok', 'jq', which('jq'));
else line('warn', 'jq', 'missing — template scripts fall back to `node -e`, which is slower but correct', install('jq'));

// Browser automation. Headless works but its UA says HeadlessChrome, which the
// template's whole stealth layer exists to avoid — so on Linux xvfb is the
// difference between "works" and "works and is not obviously a bot".
const chrome = which('google-chrome') ?? which('google-chrome-stable') ?? which('chromium')
  ?? (isDarwin && fs.existsSync('/Applications/Google Chrome.app') ? '/Applications/Google Chrome.app' : null)
  ?? (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : null);
if (chrome) line('ok', 'chrome', chrome);
else line('warn', 'chrome', 'not found — the browser-automation skill is unavailable',
  isLinux ? 'sudo apt install -y google-chrome-stable' : 'install Google Chrome');

if (isLinux && chrome) {
  if (which('xvfb-run')) line('ok', 'xvfb', which('xvfb-run'));
  else if (process.env.DISPLAY) line('ok', 'X display', process.env.DISPLAY);
  else line('warn', 'xvfb', 'no xvfb and no $DISPLAY — chrome falls back to --headless=new, whose UA is detectable',
    install('xvfb'));
}

// Secrets. The `secret` CLI reads a Keychain item on macOS and an age identity
// file on Linux, so age is genuinely required there and not here.
if (which('secret')) line('ok', 'secret CLI', which('secret'));
else line('warn', 'secret CLI', 'missing — agents cannot read stored credentials');
if (isLinux) {
  if (which('age')) line('ok', 'age', which('age'));
  else line('warn', 'age', 'missing — the secret CLI has no Keychain to fall back to on Linux', install('age'));
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0 && warned === 0) {
  console.log(`${C.ok}Everything checks out.${C.off}`);
} else if (failed === 0) {
  console.log(`${C.warn}${warned} thing${warned === 1 ? '' : 's'} degraded, nothing blocking.${C.off} The gateway will run.`);
} else {
  console.log(`${C.bad}${failed} blocking problem${failed === 1 ? '' : 's'}${warned ? `, ${warned} degraded` : ''}.${C.off} Fix the ✘ lines above first.`);
}
if (isLinux) {
  console.log(`${C.dim}Ubuntu, everything at once:${C.off}`);
  console.log(`${C.dim}  sudo apt install -y tmux zip unzip imagemagick age xvfb jq${C.off}`);
}
process.exit(failed === 0 ? 0 : 1);
