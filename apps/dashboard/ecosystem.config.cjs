// Same ecosystem on Mac and VPS. Paths use __dirname so it survives both.
// `next` + `tsx` both live in the monorepo's hoisted root node_modules; apps/
// dashboard/ doesn't have its own node_modules under npm workspaces, so we
// look two levels up.
//
// 2026-05-29: switched from `next start` to `tsx server.ts` so a single
// process can serve Next routes AND host the WebSocket endpoints used by
// the browser-terminal feature (/api/gateway/ws + /api/term/<sid>). The
// custom server still delegates every HTTP route to Next's handler — only
// WS upgrades are intercepted.
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'hermit-ui-dashboard',
      cwd: __dirname,
      script: path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      args: 'server.ts',
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
