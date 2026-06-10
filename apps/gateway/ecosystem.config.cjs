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
        PATH: `${require('os').homedir()}/.local/bin:${process.env.PATH || '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'}`,
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
