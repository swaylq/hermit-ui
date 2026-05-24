// Same ecosystem on Mac and VPS. Paths use __dirname so it survives both.
// `next` lives in the monorepo's hoisted root node_modules; apps/dashboard/
// doesn't have its own node_modules under npm workspaces, so we look two
// levels up.
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'hermit-ui-dashboard',
      cwd: __dirname,
      script: path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: `start -p ${process.env.PORT || '4101'}`,
      env: { NODE_ENV: 'production', PORT: process.env.PORT || '4101' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
