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
      // No cron_restart here on purpose (removed 2026-08-26, sway).
      //
      // There WAS a `cron_restart: '0 3 * * *'` fleet-wide restart (added 2026-08-24,
      // commit 0049cfa). It was removed because restarting on a clock pays its full
      // cost every single night whether or not anything is wrong: shutdown() exits
      // immediately without draining, so every claude-sdk session on the machine
      // loses its in-flight turn (the interrupted tool call is recorded as if the
      // user had rejected it), and --resume drops the [1m] variant so the next day's
      // first turn re-pays the whole prompt cache write.
      //
      // What it was really buying was a bound on ONE failure: the gateway wedging
      // its dashboard HTTP client while staying `online`. That is real — dgx-spark
      // sat wedged for 3 days (2026-08-23 → 08-26) and the dashboard-http circuit
      // breaker, which that build already had, never recovered it. But a nightly
      // restart is a blunt instrument for it. scripts/gateway-watch.sh now detects
      // that state directly and restarts only when it is actually present.
      //
      // If you are tempted to add a scheduled restart back, fix the wedge instead.
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
