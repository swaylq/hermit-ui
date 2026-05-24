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
