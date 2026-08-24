// tsx is hoisted to the workspace root under npm workspaces. `cwd: __dirname`
// keeps `src/index.ts` resolution + .env discovery happy.
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'hermit-ui-gateway',
      cwd: __dirname,
      script: path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      args: 'src/index.ts',
      // DASHBOARD_URL / ASST_KEY / AGENTS_ROOT come from apps/gateway/.env
      // — keep ecosystem.env minimal so VPS deploys can override via .env.
      env: {
        NODE_ENV: 'production',
        // pm2's daemon PATH often lacks ~/.local/bin (where the native `claude`
        // symlink lives). The gateway spawns each chat pane as bare `claude …`,
        // and tmux execs it with the CLIENT's PATH — so without ~/.local/bin
        // here, every NEW pane fails "claude: command not found" and dies
        // instantly ("tmux session not found" on send-keys; new-agent chats
        // never start). Prepend it. (2026-06-10)
        //
        // Kept in step with src/platform.ts extraBinPaths() by hand: this file
        // is CommonJS loaded by pm2 before any TypeScript exists, so it cannot
        // import it. Same list, same order, same reason — on Linux claude is as
        // likely to be under ~/.npm-global/bin or /snap/bin as anywhere else.
        PATH: (() => {
          const os = require('os');
          const home = os.homedir();
          const extras =
            process.platform === 'darwin'
              ? [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']
              : [`${home}/.local/bin`, '/usr/local/bin', `${home}/.npm-global/bin`, '/snap/bin'];
          const base = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
          const have = new Set(base.split(':'));
          return [...extras.filter((p) => !have.has(p)), base].join(':');
        })(),
      },
      // Nightly restart at 03:00, fleet-wide (sway, 2026-08-24). Fired by the pm2
      // daemon's own scheduler (lib/Worker.js -> croner), NOT by a hermit cron:
      // hermit crons are fired by the gateway's cron-runner, so a gateway asked
      // to restart itself would be killing the thing holding the schedule. The
      // watcher must live outside the watched, same reason gateway-watch is a
      // LaunchAgent.
      //
      // croner gets no timezone argument, so this reads in the LOCAL time of the
      // machine running the pm2 daemon. "03:00 Shanghai" is therefore only true
      // on a box whose clock is Asia/Shanghai — check `date` before assuming.
      //
      // Blast radius: shutdown() exits immediately, it does not drain. Every
      // claude-sdk session on this machine loses its in-flight turn (context
      // survives via --resume; the interrupted tool call is written as if the
      // user rejected it).
      cron_restart: '0 3 * * *',
      autorestart: true,
      max_restarts: 50,
      // Exponential backoff instead of a fixed 5s loop: a gateway that exits on a
      // config error (e.g. missing ASST_KEY) should slow its retries, not hammer
      // every 5s spamming logs + churning CPU (2026-06-30 macmini1 incident).
      exp_backoff_restart_delay: 5000,
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
