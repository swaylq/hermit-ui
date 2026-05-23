#!/usr/bin/env node
// create-hermit-agent — scaffold a new dashboard-connected Claude Code agent.
//
// Usage:
//   npx create-hermit-agent <name>                          Interactive prompts.
//   npx create-hermit-agent <name> --yes \
//     --persona "<one-line>" --user "<your-name>" \
//     --dashboard-url <url> [--brave-key <key>]             Non-interactive.
//
// <name> can be a plain folder name (placed under CWD) or an absolute/relative path.
//
// Hermit agents talk to their human through the hermit-ui dashboard
// (see https://github.com/swaylq/hermit-agent). No bot tokens, no Telegram —
// the local gateway pipes messages between dashboard and an interactive
// `claude` running in a tmux pane.

import { parseArgs } from 'node:util';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  chmodSync, statSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';

const prompts = (await import('prompts')).default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, '..');
const TEMPLATE_DIR = join(PACKAGE_DIR, 'template');

const PLATFORM = platform();
const IS_DARWIN = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function die(msg) { console.error(red('✖ ') + msg); process.exit(1); }
function step(msg) { console.log(blue('▸ ') + msg); }
function ok(msg)   { console.log(green('✓ ') + msg); }
function warn(msg) { console.log(yellow('⚠ ') + msg); }

// ── Prereqs ──────────────────────────────────────────────────────────────────

function installHint(pkg) {
  if (IS_DARWIN) return `brew install ${pkg}`;
  if (IS_LINUX) {
    if (existsSync('/usr/bin/apt-get') || existsSync('/usr/bin/apt')) return `sudo apt install ${pkg}`;
    if (existsSync('/usr/bin/dnf')) return `sudo dnf install ${pkg}`;
    if (existsSync('/usr/bin/pacman')) return `sudo pacman -S ${pkg}`;
    if (existsSync('/sbin/apk')) return `sudo apk add ${pkg}`;
  }
  return `(use your package manager to install) ${pkg}`;
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkPrereqs() {
  if (!IS_DARWIN && !IS_LINUX) {
    die(`Hermit Agent supports macOS and Linux. ${PLATFORM} is not supported (yet — PRs welcome).`);
  }
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 18) die(`Node.js 18+ required. You're on ${process.versions.node}.`);

  const claude = which('claude');
  if (!claude) die('claude CLI not found on PATH.\n  Install it from https://docs.claude.com/claude-code, then re-run.');

  const tmux = which('tmux');
  if (!tmux) die(`tmux not found on PATH.\n  Install with: ${installHint('tmux')}`);

  if (!which('curl'))  warn(`curl not found. Install with: ${installHint('curl')}`);
  if (!which('jq'))    warn(`jq not found. Some hooks need it. Install with: ${installHint('jq')}`);
  if (!which('sips') && !which('convert') && !which('magick')) {
    warn(`No image resizer found (sips / imagemagick). scripts/safe-image.sh will fail until one is installed.`);
  }
  return { claude, tmux };
}

// ── Args ─────────────────────────────────────────────────────────────────────

function parseCliArgs() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        'persona':        { type: 'string' },
        'user':           { type: 'string' },
        'dashboard-url':  { type: 'string' },
        'brave-key':      { type: 'string' },
        'yes':            { type: 'boolean', short: 'y', default: false },
        'help':           { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    die(`Invalid arguments: ${e.message}\n  Run: create-hermit-agent --help`);
  }
  if (args.values.help) {
    console.log(`
Usage:
  create-hermit-agent <name> [options]

Arguments:
  <name>                  Folder name (relative to cwd) or absolute path.

Options:
  --persona "<line>"      One-line description of the agent's focus.
                          Example: "triage my GitHub notifications".
  --user "<name>"         What the agent should call you. Defaults to your shell user.
  --dashboard-url <url>   Hermit-ui dashboard the agent reports to.
                          Default: http://127.0.0.1:4101 (local dev).
  --brave-key <key>       Optional. Brave Search API key for the brave-search skill.
  --yes, -y               Skip interactive prompts (requires the above).
  --help, -h              Show this message.

Examples:
  create-hermit-agent my-agent
  create-hermit-agent my-agent -y --persona "personal assistant" --user sway
  create-hermit-agent my-agent -y --dashboard-url https://dash.example.com
`);
    process.exit(0);
  }
  return args;
}

// ── Interactive prompts ──────────────────────────────────────────────────────

const DEFAULT_DASHBOARD = process.env.HERMIT_DASHBOARD_URL || 'http://127.0.0.1:4101';

async function collectAnswers(values, positional) {
  let name = positional;
  if (!name) {
    if (values.yes) die('Agent name is required when using --yes.');
    const r = await prompts({
      type: 'text', name: 'input',
      message: 'Agent name (folder)',
      initial: 'hermit',
      validate: (v) => {
        if (!v) return 'Required';
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(basename(v))) {
          return 'Use lowercase letters, digits, - or _ (must start alphanumeric)';
        }
        return true;
      },
    });
    if (!r.input) process.exit(1);
    name = r.input.trim();
  }

  const targetDir = resolve(process.cwd(), name);
  if (existsSync(targetDir)) die(`Directory already exists: ${targetDir}`);
  if (!existsSync(dirname(targetDir))) die(`Parent directory does not exist: ${dirname(targetDir)}`);

  let persona = values.persona;
  if (!persona) {
    if (values.yes) persona = 'personal assistant';
    else {
      const r = await prompts({
        type: 'text', name: 'persona',
        message: 'Persona — one line, what does this agent focus on?',
        initial: 'personal assistant',
      });
      persona = (r.persona || 'personal assistant').trim();
    }
  }

  let userName = values.user;
  if (!userName) {
    const shellUser = process.env.USER || process.env.LOGNAME || 'friend';
    if (values.yes) userName = shellUser;
    else {
      const r = await prompts({
        type: 'text', name: 'userName',
        message: 'Your name (what the agent calls you)',
        initial: shellUser,
      });
      userName = (r.userName || shellUser).trim();
    }
  }

  let dashboardUrl = values['dashboard-url'];
  if (!dashboardUrl) {
    if (values.yes) dashboardUrl = DEFAULT_DASHBOARD;
    else {
      const r = await prompts({
        type: 'text', name: 'url',
        message: 'Hermit-ui dashboard URL (where the agent reports)',
        initial: DEFAULT_DASHBOARD,
      });
      dashboardUrl = (r.url || DEFAULT_DASHBOARD).trim();
    }
  }
  // Strip trailing slash so substitutions look clean.
  dashboardUrl = dashboardUrl.replace(/\/+$/, '');

  let braveKey = values['brave-key'];
  if (!braveKey && !values.yes) {
    const r = await prompts({
      type: 'text', name: 'braveKey',
      message: 'Brave Search API key (optional — leave blank to skip)',
      initial: '',
    });
    braveKey = (r.braveKey || '').trim();
  }
  braveKey = braveKey || '';

  const agentName = basename(targetDir);
  const displayName = agentName.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return { agentName, displayName, persona, userName, dashboardUrl, braveKey, targetDir };
}

// ── Template copy ────────────────────────────────────────────────────────────

const TEXT_EXTS = new Set([
  '.md', '.json', '.js', '.ts', '.sh', '.bash', '.zsh',
  '.toml', '.yml', '.yaml', '.tmpl', '.gitkeep', '.gitignore',
]);

function isTextFile(path) {
  if (path.endsWith('.gitignore') || path.endsWith('.gitkeep')) return true;
  const i = path.lastIndexOf('.');
  if (i < 0) return true;
  return TEXT_EXTS.has(path.slice(i));
}

function substitute(content, vars) {
  return content.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

function walkCopy(srcDir, destDir, vars) {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    let destName = entry.name;
    if (destName.endsWith('.tmpl')) destName = destName.slice(0, -5);
    const destPath = join(destDir, destName);

    if (entry.isDirectory()) {
      walkCopy(srcPath, destPath, vars);
    } else if (entry.isFile()) {
      if (isTextFile(srcPath)) {
        writeFileSync(destPath, substitute(readFileSync(srcPath, 'utf8'), vars));
      } else {
        writeFileSync(destPath, readFileSync(srcPath));
      }
      try { chmodSync(destPath, statSync(srcPath).mode); } catch {}
    }
  }
}

// ── settings.local.json ──────────────────────────────────────────────────────

function writeSettingsLocal(targetDir, dashboardUrl, braveKey) {
  const claudeDir = join(targetDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.local.json');
  const env = { HERMIT_DASHBOARD_URL: dashboardUrl };
  if (braveKey) env.BRAVE_API_KEY = braveKey;
  const settings = {
    env,
    permissions: {
      // Permit common no-risk operations; users tighten/loosen later.
      allow: [
        'Read(**)',
        'Write(' + targetDir + '/**)',
        'Edit(' + targetDir + '/**)',
        'Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(rg *)',
        'Bash(git *)', 'Bash(node *)', 'Bash(npm *)', 'Bash(npx *)',
      ],
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
  ok(`.claude/settings.local.json written`);
}

// ── Pre-acknowledge Claude first-run dialogs ─────────────────────────────────
// Two blocking TUI dialogs would otherwise wedge the headless agent:
//   1) "Trust this folder?" (per-project)
//   2) "Allow --dangerously-skip-permissions?" (user-scope, once ever)
// We write the keys Claude Code would write after a Yes click.

function preAckClaudeDialogs(targetDir) {
  step('Pre-acknowledging first-run Claude Code dialogs…');

  // User-scope.
  const userSettingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    mkdirSync(dirname(userSettingsPath), { recursive: true });
    let s = {};
    if (existsSync(userSettingsPath)) {
      try { s = JSON.parse(readFileSync(userSettingsPath, 'utf8')); } catch {}
    }
    if (!s.skipDangerousModePermissionPrompt) {
      s.skipDangerousModePermissionPrompt = true;
      writeFileSync(userSettingsPath, JSON.stringify(s, null, 2) + '\n');
      ok('skipDangerousModePermissionPrompt set in ~/.claude/settings.json');
    }
  } catch (e) {
    warn(`Could not pre-ack user dialogs: ${e.message}`);
  }

  // Project-scope: write trust marker.
  const projTrust = join(targetDir, '.claude', 'project-trust.json');
  try {
    mkdirSync(dirname(projTrust), { recursive: true });
    writeFileSync(projTrust, JSON.stringify({ trusted: true, trustedAt: new Date().toISOString() }, null, 2) + '\n');
    ok('project-trust.json written');
  } catch (e) {
    warn(`Could not write project-trust.json: ${e.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold('\ncreate-hermit-agent\n'));
  checkPrereqs();

  const args = parseCliArgs();
  const positional = args.positionals[0];
  const a = await collectAnswers(args.values, positional);

  step(`Scaffolding ${bold(a.agentName)} at ${a.targetDir}`);
  const vars = {
    AGENT_NAME: a.agentName,
    AGENT_DISPLAY_NAME: a.displayName,
    PERSONA: a.persona,
    USER_NAME: a.userName,
    AGENT_DIR: a.targetDir,
    DASHBOARD_URL: a.dashboardUrl,
  };
  walkCopy(TEMPLATE_DIR, a.targetDir, vars);
  ok(`Template copied to ${a.targetDir}`);

  writeSettingsLocal(a.targetDir, a.dashboardUrl, a.braveKey);
  preAckClaudeDialogs(a.targetDir);

  // npm install for any deps the template ships (e.g. playwright for browser skill).
  const pkgPath = join(a.targetDir, 'package.json');
  if (existsSync(pkgPath)) {
    step('Running npm install…');
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], {
      cwd: a.targetDir, stdio: 'inherit',
    });
    if (r.status !== 0) {
      warn(`npm install exited ${r.status}. Re-run manually in ${a.targetDir} if needed.`);
    } else {
      ok('npm install complete');
    }
  }

  console.log(`\n${green('✓')} ${bold(a.agentName)} ready.\n`);
  console.log(`Next steps:`);
  console.log(`  1. cd ${a.targetDir}`);
  console.log(`  2. ./start.sh        ${dim('# launches a tmux pane with claude')}`);
  console.log(`  3. open ${a.dashboardUrl}/chat?agent=${encodeURIComponent(a.agentName)}`);
  console.log(`\n${dim('Edit IDENTITY.md, USER.md, AGENTS.md, TOOLS.md to tailor the agent.')}\n`);
}

main().catch((err) => {
  console.error(red('Error:'), err?.stack || err);
  process.exit(1);
});
